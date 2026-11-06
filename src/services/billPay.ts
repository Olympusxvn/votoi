import { and, eq, lte } from "drizzle-orm";
import { isValidSuiAddress } from "@mysten/sui/utils";
import { db } from "../db/client";
import {
  agentPayments,
  scheduledBills,
  transactions,
  type BillFrequency,
  type ScheduledBill,
} from "../db/schema";
import { AGENT_PAYMENT_CAP_USD } from "../config/tatum";
import {
  HumanApprovalRequired,
  getAgentSpenderAddress,
  spendFromAllowance,
} from "./agentPayments";
import {
  findAllowancesForSpender,
  formatUsd,
  getAllowanceState,
  getSuiUsdRate,
  mistToUsd,
  usdToMist,
} from "./suiReads";
import { recordPaymentMemory } from "./paymentMemory";
import { screenSuiAddress } from "./tatumData";
import { ensureUser } from "./rehydration";

/**
 * Autonomous bill pay: the agent scans due bills and settles them through
 * the funder's allowance with no chat command. Every bill re-checks the
 * same guards as a chat payment (cap, recipient screening, live rate,
 * covering allowance, simulation gate inside spendFromAllowance) and
 * lands in the ledger plus Walrus payment memory.
 */

/** Pure scheduling helper: next due date, or null when a once bill ends. */
export function advanceDueDate(from: Date, frequency: BillFrequency): Date | null {
  if (frequency === "once") return null;
  const d = new Date(from.getTime());
  if (frequency === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export type BillRunStatus = "settled" | "awaiting_approval" | "failed" | "skipped";

export interface BillRunResult {
  billId: string;
  payeeName: string;
  status: BillRunStatus;
  digest?: string;
  reason?: string;
}

async function runOneBill(bill: ScheduledBill): Promise<BillRunResult> {
  const amountUsd = Number(bill.amountUsd);
  const fail = async (reason: string): Promise<BillRunResult> => {
    await db
      .update(scheduledBills)
      .set({ lastRunAt: new Date(), lastError: reason.slice(0, 500) })
      .where(eq(scheduledBills.billId, bill.billId));
    return { billId: bill.billId, payeeName: bill.payeeName, status: "failed", reason };
  };
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return fail(`invalid bill amount: ${bill.amountUsd}`);
  }
  if (amountUsd > AGENT_PAYMENT_CAP_USD) return fail(`bill ${formatUsd(amountUsd)} USD is above the auto-pay cap`);
  if (!isValidSuiAddress(bill.recipient)) return fail("invalid recipient address");
  const screen = await screenSuiAddress(bill.recipient);
  if (screen.verdict === "blocked") {
    await db.insert(agentPayments).values({
      userId: bill.userId,
      standard: "x402",
      recipients: [{ address: bill.recipient, amountUsd }],
      totalUsd: amountUsd.toFixed(4),
      status: "blocked",
      failureReason: screen.detail.slice(0, 500),
    });
    return fail(screen.detail);
  }
  const rate = await getSuiUsdRate();
  if (rate === null) return fail("no SUI/USD rate available");
  const amountMist = usdToMist(amountUsd, rate);
  const spender = getAgentSpenderAddress();

  let allowanceId = bill.allowanceId;
  if (allowanceId) {
    const st = await getAllowanceState(allowanceId).catch(() => null);
    const covers =
      st !== null &&
      st.spender === spender &&
      (st.remainingMist === null || st.remainingMist >= amountMist) &&
      (st.expirationMs === null || st.expirationMs > Date.now());
    if (!covers) return fail("pinned allowance cannot cover this bill");
  } else {
    const allowances = await findAllowancesForSpender(bill.userId, spender);
    const found = allowances.find(
      (a) =>
        (a.remainingMist === null || a.remainingMist >= amountMist) &&
        (a.expirationMs === null || a.expirationMs > Date.now()),
    );
    if (!found) return fail("no active allowance covers this bill");
    allowanceId = found.allowanceId;
  }

  try {
    const result = await spendFromAllowance({
      allowanceId,
      funder: bill.userId,
      recipients: [{ address: bill.recipient, amountMist }],
      totalUsd: amountUsd,
    });
    await db.insert(agentPayments).values({
      userId: bill.userId,
      standard: "x402",
      recipients: [{ address: bill.recipient, amountUsd }],
      totalUsd: amountUsd.toFixed(4),
      status: "settled",
      txHash: result.digest,
      gasUsd: mistToUsd(result.gasMist, rate).toFixed(4),
      transport: result.transport,
      settledAt: new Date(),
    });
    await db.insert(transactions).values({
      userId: bill.userId,
      merchantName: bill.payeeName,
      amountUsd: amountUsd.toFixed(4),
      source: "agent_payment",
      txHash: result.digest,
    });
    const next = advanceDueDate(new Date(), bill.frequency);
    await db
      .update(scheduledBills)
      .set({
        lastDigest: result.digest,
        lastRunAt: new Date(),
        lastError: null,
        ...(next ? { nextDueAt: next } : { status: "done" as const }),
      })
      .where(eq(scheduledBills.billId, bill.billId));
    await recordPaymentMemory({
      userId: bill.userId,
      totalUsd: amountUsd,
      status: "settled",
      standard: "x402",
      recipientCount: 1,
      digest: result.digest,
    });
    return { billId: bill.billId, payeeName: bill.payeeName, status: "settled", digest: result.digest };
  } catch (err) {
    if (err instanceof HumanApprovalRequired) {
      await db.insert(agentPayments).values({
        userId: bill.userId,
        standard: "x402",
        recipients: [{ address: bill.recipient, amountUsd }],
        totalUsd: amountUsd.toFixed(4),
        status: "awaiting_approval",
      });
      return {
        billId: bill.billId,
        payeeName: bill.payeeName,
        status: "awaiting_approval",
        reason: err.message,
      };
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Settle every due bill (all users, or one). Per-bill isolation: one bad
 *  bill never aborts the pass. */
export async function runBillPayPass(userId?: string): Promise<BillRunResult[]> {
  const conds = [eq(scheduledBills.status, "active"), lte(scheduledBills.nextDueAt, new Date())];
  if (userId) conds.push(eq(scheduledBills.userId, userId));
  const due = await db.select().from(scheduledBills).where(and(...conds)).limit(25);
  const out: BillRunResult[] = [];
  for (const bill of due) {
    try {
      out.push(await runOneBill(bill));
    } catch (err) {
      out.push({
        billId: bill.billId,
        payeeName: bill.payeeName,
        status: "failed",
        reason: (err as Error).message.slice(0, 200),
      });
    }
  }
  return out;
}

export interface CreateBillInput {
  userId: string;
  payeeName: string;
  recipient: string;
  amountUsd: number;
  frequency: BillFrequency;
  allowanceId?: string;
  nextDueAt?: Date;
}

export async function createBill(input: CreateBillInput): Promise<ScheduledBill> {
  if (!isValidSuiAddress(input.userId)) throw new Error("userId must be a valid Sui wallet address.");
  if (!isValidSuiAddress(input.recipient)) throw new Error("recipient must be a valid Sui wallet address.");
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    throw new Error("amountUsd must be positive.");
  }
  if (input.amountUsd > AGENT_PAYMENT_CAP_USD) {
    throw new Error(`amountUsd above the ${AGENT_PAYMENT_CAP_USD.toFixed(2)} USD auto-pay cap.`);
  }
  await ensureUser(input.userId);
  const [row] = await db
    .insert(scheduledBills)
    .values({
      userId: input.userId,
      payeeName: input.payeeName.slice(0, 120),
      recipient: input.recipient,
      amountUsd: input.amountUsd.toFixed(4),
      frequency: input.frequency,
      allowanceId: input.allowanceId ?? null,
      nextDueAt: input.nextDueAt ?? new Date(),
    })
    .returning();
  return row;
}
