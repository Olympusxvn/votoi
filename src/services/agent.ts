import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/client";
import {
  agentPayments,
  chatMessages,
  learnedFacts,
  transactions,
  type LearnedFact,
} from "../db/schema";
import { rehydrateUser } from "./rehydration";
import {
  HumanApprovalRequired,
  getAgentSpenderAddress,
  spendFromAllowance,
} from "./agentPayments";
import {
  findAllowancesForSpender,
  formatUsd,
  getSuiBalanceMist,
  getSuiUsdRate,
  mistToUsd,
  usdToMist,
} from "./suiReads";
import { screenSuiAddress } from "./tatumData";
import { recordPaymentMemoryAsync } from "./paymentMemory";
import { PROFILE_SUBJECT } from "../config/walrus";
import { AGENT_PAYMENT_CAP_USD } from "../config/tatum";

/**
 * The watchdog chat brain (SPEC 2.1). Pipeline per message:
 *   1. Rehydration gate (RULE.md section 4): on a cold cache the facts
 *      are rebuilt from Walrus before anything is answered.
 *   2. Deterministic intents first - log an expense, pay via allowance -
 *      because they move money or write the ledger and must never be
 *      hallucinated by a model.
 *   3. Questions are answered from the cached facts and ledger. When an
 *      OpenAI-compatible LLM is configured (LLM_API_KEY / LLM_BASE_URL /
 *      LLM_MODEL), it phrases the answer over the same grounded context;
 *      otherwise, and on any LLM failure, a deterministic composer
 *      answers from the facts.
 * Everything monetary is USD in the ledger; SUI is only the settlement
 * asset, converted at the live rate (services/suiReads.getSuiUsdRate).
 */

export interface ChatInput {
  userId: string;
  sessionId: string;
  message: string;
}

export type ChatAction =
  | "info"
  | "expense_logged"
  | "payment_settled"
  | "payment_needs_approval"
  | "payment_failed";

export interface ChatResult {
  response: string;
  action: ChatAction;
  txDigest?: string;
}

const PAYMENT_PATTERN =
  /\b(?:pay|send|transfer)\s+\$?(\d+(?:\.\d{1,2})?)\s*(?:usd\s+)?to\s+(0x[0-9a-fA-F]{64})\b/i;
const EXPENSE_PATTERN =
  /\b(?:spent|paid|bought|logged?)\s+\$?(\d+(?:\.\d{1,2})?)\s*(?:usd\s+)?(?:at|on|for)\s+([a-z0-9&' .-]+)/i;

function factText(fact: LearnedFact): string {
  return fact.factPayload.serializedString;
}

/** The mental model leads: settled knowledge first, details after. */
function profileFirst(facts: LearnedFact[]): LearnedFact[] {
  return [...facts].sort((a, b) => {
    const pa = a.subject === PROFILE_SUBJECT ? 0 : 1;
    const pb = b.subject === PROFILE_SUBJECT ? 0 : 1;
    return pa - pb;
  });
}

function findFactFor(facts: LearnedFact[], needle: string): LearnedFact | undefined {
  const n = needle.toLowerCase();
  return facts.find(
    (f) =>
      f.subject.toLowerCase() === n ||
      factText(f).toLowerCase().includes(n),
  );
}

async function monthToDateSpend(userId: string, merchant?: string): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const conditions = [
    eq(transactions.userId, userId),
    gte(transactions.occurredAt, start),
  ];
  if (merchant) conditions.push(eq(transactions.merchantName, merchant));
  const rows = await db
    .select({ amountUsd: transactions.amountUsd })
    .from(transactions)
    .where(and(...conditions));
  return rows.reduce((sum, r) => sum + Number(r.amountUsd), 0);
}

async function logExpense(
  userId: string,
  facts: LearnedFact[],
  amountUsd: number,
  merchantRaw: string,
): Promise<ChatResult> {
  const merchant = merchantRaw.trim().replace(/\s+/g, " ");
  await db.insert(transactions).values({
    userId,
    merchantName: merchant,
    amountUsd: amountUsd.toFixed(4),
    source: "manual",
  });
  const monthTotal = await monthToDateSpend(userId, merchant);
  let response =
    `Logged ${formatUsd(amountUsd)} USD at ${merchant}. ` +
    `Month to date at ${merchant}: ${formatUsd(monthTotal)} USD.`;
  const fact = findFactFor(facts, merchant);
  if (fact) {
    response += ` Watchdog rule on file: ${factText(fact).split("|")[2]?.trim() ?? ""}`;
  }
  return { response, action: "expense_logged" };
}

async function payViaAllowance(
  userId: string,
  amountUsd: number,
  recipient: string,
): Promise<ChatResult> {
  if (amountUsd > AGENT_PAYMENT_CAP_USD) {
    await db.insert(agentPayments).values({
      userId,
      standard: "x402",
      recipients: [{ address: recipient, amountUsd }],
      totalUsd: amountUsd.toFixed(4),
      status: "awaiting_approval",
    });
    recordPaymentMemoryAsync({
      userId,
      totalUsd: amountUsd,
      status: "awaiting_approval",
      standard: "x402",
      recipientCount: 1,
    });
    return {
      response:
        `That is ${formatUsd(amountUsd)} USD, above the ` +
        `${AGENT_PAYMENT_CAP_USD.toFixed(2)} USD auto-pay cap. I recorded it as ` +
        `awaiting your manual approval - nothing was sent.`,
      action: "payment_needs_approval",
    };
  }

  const screen = await screenSuiAddress(recipient);
  if (screen.verdict === "blocked") {
    await db.insert(agentPayments).values({
      userId,
      standard: "x402",
      recipients: [{ address: recipient, amountUsd }],
      totalUsd: amountUsd.toFixed(2),
      status: "blocked",
      failureReason: screen.detail.slice(0, 500),
    });
    return {
      response: `I refused that payment: ${screen.detail}. Nothing was sent.`,
      action: "payment_failed",
    };
  }

  const rate = await getSuiUsdRate();
  if (rate === null) {
    return {
      response: "I cannot get a live SUI/USD rate right now, so I will not send a payment I cannot price.",
      action: "payment_failed",
    };
  }
  const amountMist = usdToMist(amountUsd, rate);
  const spender = getAgentSpenderAddress();
  const allowances = await findAllowancesForSpender(userId, spender);
  const allowance = allowances.find(
    (a) =>
      (a.remainingMist === null || a.remainingMist >= amountMist) &&
      (a.expirationMs === null || a.expirationMs > Date.now()),
  );
  if (!allowance) {
    return {
      response:
        `No active allowance from your wallet covers ${formatUsd(amountUsd)} USD ` +
        `(${(Number(amountMist) / 1e9).toFixed(4)} SUI). Issue one to the agent ` +
        `(${spender}) and try again.`,
      action: "payment_failed",
    };
  }

  try {
    const result = await spendFromAllowance({
      allowanceId: allowance.allowanceId,
      funder: userId,
      recipients: [{ address: recipient, amountMist }],
      totalUsd: amountUsd,
    });
    await db.insert(agentPayments).values({
      userId,
      standard: "x402",
      recipients: [{ address: recipient, amountUsd }],
      totalUsd: amountUsd.toFixed(4),
      status: "settled",
      txHash: result.digest,
      gasUsd: mistToUsd(result.gasMist, rate).toFixed(4),
      transport: result.transport,
      settledAt: new Date(),
    });
    await db.insert(transactions).values({
      userId,
      merchantName: "agent payment",
      amountUsd: amountUsd.toFixed(4),
      source: "agent_payment",
      txHash: result.digest,
    });
    recordPaymentMemoryAsync({
      userId,
      totalUsd: amountUsd,
      status: "settled",
      standard: "x402",
      recipientCount: 1,
      digest: result.digest,
    });
    return {
      response:
        `Paid ${formatUsd(amountUsd)} USD to ${recipient} through your allowance ` +
        `(settled via ${result.transport}). Onchain digest: ${result.digest}.`,
      action: "payment_settled",
      txDigest: result.digest,
    };
  } catch (err) {
    if (err instanceof HumanApprovalRequired) {
      return {
        response: `Payment blocked by the auto-pay cap: ${err.message}`,
        action: "payment_needs_approval",
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    await db.insert(agentPayments).values({
      userId,
      standard: "x402",
      recipients: [{ address: recipient, amountUsd }],
      totalUsd: amountUsd.toFixed(4),
      status: "failed",
      failureReason: reason.slice(0, 500),
    });
    return {
      response: `The payment failed before settling: ${reason.slice(0, 200)}`,
      action: "payment_failed",
    };
  }
}

async function llmAnswer(
  facts: LearnedFact[],
  message: string,
): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const context = profileFirst(facts).map(factText).join("\n");
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are VOTOI, an expense watchdog. Answer only from these learned facts about the user, amounts in USD:\n" +
              context,
          },
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return body.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

async function answerQuestion(
  userId: string,
  facts: LearnedFact[],
  message: string,
): Promise<ChatResult> {
  const lower = message.toLowerCase();
  if (lower.includes("balance")) {
    const mist = await getSuiBalanceMist(userId);
    const rate = await getSuiUsdRate();
    const sui = (Number(mist) / 1e9).toFixed(4);
    const usd = rate === null ? "n/a" : formatUsd(mistToUsd(mist, rate));
    return {
      response: `Your wallet holds ${sui} SUI (about ${usd} USD).`,
      action: "info",
    };
  }

  const fromLlm = await llmAnswer(facts, message);
  if (fromLlm) return { response: fromLlm, action: "info" };

  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const matched = facts.filter((f) => {
    const text = factText(f).toLowerCase();
    return words.some((w) => text.includes(w));
  });
  const chosen = profileFirst(matched.length > 0 ? matched : facts).slice(0, 3);
  if (chosen.length === 0) {
    return {
      response: "I have no learned facts for you yet. Log an expense or upload a receipt and I will start watching.",
      action: "info",
    };
  }
  const monthTotal = await monthToDateSpend(userId);
  const lines = chosen.map((f) => `- ${factText(f)}`);
  return {
    response:
      `Here is what I know from your Walrus memory:\n${lines.join("\n")}\n` +
      `Total logged this month: ${monthTotal.toFixed(2)} USD.`,
    action: "info",
  };
}

export async function handleChat(input: ChatInput): Promise<ChatResult> {
  const { userId, sessionId, message } = input;
  // Rehydration gate: fast SELECT on a warm cache, full Walrus rebuild
  // on a cold one - either way the facts below are canonical.
  const { facts, degraded } = await rehydrateUser(userId);

  await db.insert(chatMessages).values({
    userId,
    sessionId,
    role: "user",
    content: message,
  });

  let result: ChatResult;
  const payment = PAYMENT_PATTERN.exec(message);
  const expense = payment ? null : EXPENSE_PATTERN.exec(message);
  if (payment) {
    result = await payViaAllowance(userId, Number(payment[1]), payment[2]);
  } else if (expense) {
    result = await logExpense(userId, facts, Number(expense[1]), expense[2]);
  } else {
    result = await answerQuestion(userId, facts, message);
  }

  if (degraded) {
    result = {
      ...result,
      response:
        result.response +
        "\n(Note: Walrus Memory is temporarily unreachable, so this answer used no long-term memory.)",
    };
  }

  await db.insert(chatMessages).values({
    userId,
    sessionId,
    role: "assistant",
    content: result.response,
  });
  return result;
}

/** Recent facts helper for the UI/debug routes. */
export async function listFacts(userId: string): Promise<LearnedFact[]> {
  return db
    .select()
    .from(learnedFacts)
    .where(and(eq(learnedFacts.userId, userId), eq(learnedFacts.status, "active")))
    .orderBy(desc(learnedFacts.lastUpdated));
}
