import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agentPayments } from "../db/schema";
import {
  parseWatchdogFact,
  serializeWatchdogFact,
} from "../config/walrus";
import { extractRevision, getCachedFacts } from "./rehydration";
import { writeFactDurably } from "../workers/compactDream";

/**
 * The money-to-memory loop: every agent payment updates the standing
 * "agent autopay" payment_rule fact on Walrus, so the next spend is
 * authorized by a memory that includes all previous spends. Called
 * fire-and-forget from chat (latency) and awaited from background
 * passes (bills, approvals).
 */

export const AUTOPAY_SUBJECT = "agent autopay";
const DEFAULT_RULE =
  "require human approval for any agent payment above 50 USD per transaction";

export interface PaymentMemoryInput {
  userId: string;
  totalUsd: number;
  status: "settled" | "awaiting_approval" | "failed" | "blocked";
  standard: string;
  recipientCount: number;
  digest?: string;
}

export async function recordPaymentMemory(input: PaymentMemoryInput): Promise<void> {
  const rows = await db
    .select()
    .from(agentPayments)
    .where(eq(agentPayments.userId, input.userId));
  const settled = rows.filter((r) => r.status === "settled");
  const pending = rows.filter((r) => r.status === "awaiting_approval").length;
  const sum = settled.reduce((s, r) => s + Number(r.totalUsd), 0);
  const lastDigest =
    input.digest ??
    [...settled].sort(
      (a, b) => (b.settledAt ?? b.createdAt).getTime() - (a.settledAt ?? a.createdAt).getTime(),
    )[0]?.txHash ??
    null;

  const facts = await getCachedFacts(input.userId);
  const existing = facts.find(
    (f) => f.factType === "payment_rule" && f.subject === AUTOPAY_SUBJECT,
  );
  const parsed = existing
    ? parseWatchdogFact(existing.factPayload.serializedString)
    : null;
  const revision = existing
    ? (parsed ? extractRevision(parsed.pattern) : existing.version) + 1
    : 1;
  const pattern =
    `settled ${settled.length} payments totaling ${sum.toFixed(2)} USD, ` +
    `${pending} awaiting approval, last ${lastDigest ? lastDigest.slice(0, 8) : "none"}, ` +
    `evidence ${settled.length} pays, rev ${revision}`;
  const serialized = serializeWatchdogFact({
    factType: "payment_rule",
    subject: AUTOPAY_SUBJECT,
    pattern,
    rule: parsed?.rule ?? DEFAULT_RULE,
  });
  if (existing?.factPayload.serializedString === serialized) return;
  await writeFactDurably({
    userId: input.userId,
    factType: "payment_rule",
    subject: AUTOPAY_SUBJECT,
    serialized,
    version: revision,
  });
}

/** Fire-and-forget wrapper for the latency-sensitive chat path. */
export function recordPaymentMemoryAsync(input: PaymentMemoryInput): void {
  void recordPaymentMemory(input).catch((err) => {
    console.warn(`payment memory write failed: ${(err as Error).message}`);
  });
}
