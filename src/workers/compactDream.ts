import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  learnedFacts,
  pendingWrites,
  syncState,
  transactions,
  users,
  type LearnedFact,
  type PendingWrite,
  type Transaction,
} from "../db/schema";
import {
  awaitFact,
  factIdempotencyKey,
  getFactJobStatus,
  parseWatchdogFact,
  PROFILE_SUBJECT,
  serializeWatchdogFact,
  submitFact,
} from "../config/walrus";
import { extractRevision } from "../services/rehydration";

/**
 * The deep-learning loop (RULE.md Guardrail 3, SPEC 3.2): condense raw
 * transaction logs into evolving Clean Facts instead of letting memory
 * accumulate raw entries.
 *
 * Two Hindsight-inspired upgrades (promoted from non-goals 2026-10-22):
 * - Evidence counts: every habit pattern carries "evidence N txs", the
 *   number of ledger transactions consolidated into the belief, so a
 *   fact shows how much proof stands behind it.
 * - Mental model: one standing "spending profile" fact per user,
 *   re-synthesized here in the background whenever the ledger moves, so
 *   the chat agent can boot from settled knowledge (agent.ts reads it
 *   first) instead of re-deriving a picture on every turn.
 *
 * Writes go through the durable pipeline (pending_writes): persist the
 * frozen intent + idempotency key, submit to MemWal, record the job_id,
 * and only mark the fact active once its blob exists (RULE.md Boundary
 * 2). A crash anywhere in that sequence is recovered by
 * recoverPendingWrites() at the start of the next pass - the pattern
 * from upstream issues #1048/#1049. Walrus stays append-only: each
 * mutation is a new blob with the revision bumped ("rev N" at the end
 * of the pattern), Postgres holds the pointer to the current belief,
 * and the superseded blobs remain as an auditable belief history.
 * The user's existing rule segment is preserved verbatim on habit
 * mutations: rules are intent, patterns are statistics.
 */

const MIN_TXS = 5;
const MS_PER_WEEK = 7 * 24 * 3600 * 1000;

// ------------------------------------------------------- durable writes

async function finalizePendingWrite(row: PendingWrite, blobId: string) {
  await db
    .insert(learnedFacts)
    .values({
      userId: row.userId,
      factType: row.factType,
      subject: row.subject,
      factPayload: { serializedString: row.serialized },
      walrusBlobId: blobId,
      version: row.version,
      status: "active",
    })
    .onConflictDoUpdate({
      target: [learnedFacts.userId, learnedFacts.factType, learnedFacts.subject],
      set: {
        factPayload: { serializedString: row.serialized },
        walrusBlobId: blobId,
        version: row.version,
        status: "active",
      },
    });
  await db.delete(pendingWrites).where(eq(pendingWrites.writeId, row.writeId));
}

/** Persist intent -> submit -> record job -> await blob -> activate. */
export async function writeFactDurably(input: {
  userId: string;
  factType: string;
  subject: string;
  serialized: string;
  version: number;
}): Promise<string> {
  const [row] = await db
    .insert(pendingWrites)
    .values({
      userId: input.userId,
      factType: input.factType,
      subject: input.subject,
      serialized: input.serialized,
      idempotencyKey: factIdempotencyKey(input.userId, input.serialized),
      version: input.version,
    })
    .returning();
  const { jobId } = await submitFact(input.userId, input.serialized);
  await db
    .update(pendingWrites)
    .set({ walrusJobId: jobId })
    .where(eq(pendingWrites.writeId, row.writeId));
  const blobId = await awaitFact(jobId);
  await finalizePendingWrite({ ...row, walrusJobId: jobId }, blobId);
  return blobId;
}

export interface RecoverySummary {
  finalized: number;
  dropped: number;
  stillPending: number;
}

/** Resolve every interrupted write left by a crashed pass. */
export async function recoverPendingWrites(): Promise<RecoverySummary> {
  const rows = await db.select().from(pendingWrites);
  let finalized = 0;
  let dropped = 0;
  let stillPending = 0;
  for (const row of rows) {
    try {
      let jobId = row.walrusJobId;
      if (!jobId) {
        // Crashed between intent and acceptance. The idempotency key is
        // deterministic, so resubmitting collapses onto the original
        // job if the relayer had in fact accepted it.
        const submitted = await submitFact(row.userId, row.serialized);
        jobId = submitted.jobId;
        await db
          .update(pendingWrites)
          .set({ walrusJobId: jobId })
          .where(eq(pendingWrites.writeId, row.writeId));
      }
      const status = await getFactJobStatus(jobId);
      if (status.status === "done" && status.blob_id) {
        await finalizePendingWrite(row, status.blob_id);
        finalized++;
      } else if (status.status === "failed" || status.status === "not_found") {
        // Dead write: drop the intent; the next compaction pass
        // recomputes the fact from the ledger and tries again.
        await db.delete(pendingWrites).where(eq(pendingWrites.writeId, row.writeId));
        dropped++;
      } else {
        const blobId = await awaitFact(jobId);
        await finalizePendingWrite(row, blobId);
        finalized++;
      }
    } catch {
      stillPending++;
    }
  }
  return { finalized, dropped, stillPending };
}

// ------------------------------------------------------------ compaction

function getFact(
  facts: LearnedFact[],
  factType: string,
  subject: string,
): LearnedFact | undefined {
  return facts.find((f) => f.factType === factType && f.subject === subject);
}

async function compactMerchant(
  userId: string,
  merchant: string,
  list: Transaction[],
  facts: LearnedFact[],
): Promise<boolean> {
  if (list.length < MIN_TXS) return false;
  const total = list.reduce((sum, tx) => sum + Number(tx.amountUsd), 0);
  const average = total / list.length;
  const times = list.map((tx) => tx.occurredAt.getTime());
  const spanWeeks = Math.max((Math.max(...times) - Math.min(...times)) / MS_PER_WEEK, 1);
  const perWeek = list.length / spanWeeks;

  const existing = getFact(facts, "merchant_habit", merchant);
  const existingParsed = existing
    ? parseWatchdogFact(existing.factPayload.serializedString)
    : null;
  const revision = existing
    ? (existingParsed
        ? extractRevision(existingParsed.pattern)
        : existing.version) + 1
    : 1;
  const pattern =
    `spends ${perWeek.toFixed(1)}x per week, avg ${average.toFixed(2)} USD per order, ` +
    `evidence ${list.length} txs, rev ${revision}`;
  const rule =
    existingParsed?.rule ??
    `warn when weekly ${merchant} spend passes ${(average * perWeek * 1.25).toFixed(2)} USD`;
  const serialized = serializeWatchdogFact({
    factType: "merchant_habit",
    subject: merchant,
    pattern,
    rule,
  });
  if (existing && existing.factPayload.serializedString === serialized) {
    return false; // No delta, no Walrus write (compaction, not accumulation).
  }
  await writeFactDurably({
    userId,
    factType: "merchant_habit",
    subject: merchant,
    serialized,
    version: revision,
  });
  return true;
}

/** The mental model: one synthesized profile fact per user. */
async function synthesizeProfile(
  userId: string,
  txs: Transaction[],
  facts: LearnedFact[],
): Promise<boolean> {
  if (txs.length < MIN_TXS) return false;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const thisMonth = txs.filter((tx) => tx.occurredAt >= monthStart);
  const monthTotal = thisMonth.reduce((sum, tx) => sum + Number(tx.amountUsd), 0);

  const byMerchant = new Map<string, number>();
  for (const tx of txs) {
    byMerchant.set(tx.merchantName, (byMerchant.get(tx.merchantName) ?? 0) + Number(tx.amountUsd));
  }
  const top = [...byMerchant.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const topText = top.map(([name, amt]) => `${name} ${amt.toFixed(2)} USD`).join(", ");

  const existing = getFact(facts, "preference", PROFILE_SUBJECT);
  const existingParsed = existing
    ? parseWatchdogFact(existing.factPayload.serializedString)
    : null;
  const revision = existing
    ? (existingParsed
        ? extractRevision(existingParsed.pattern)
        : existing.version) + 1
    : 1;
  const risk = facts.find((f) => f.factType === "budget_risk");
  const pattern =
    `monthly spend ${monthTotal.toFixed(2)} USD over ${thisMonth.length} txs, ` +
    `top: ${topText}, evidence ${txs.length} txs, rev ${revision}`;
  const rule = risk
    ? `watch ${risk.subject} first`
    : `watch ${top[0]?.[0] ?? "spending"} first`;
  const serialized = serializeWatchdogFact({
    factType: "preference",
    subject: PROFILE_SUBJECT,
    pattern,
    rule,
  });
  if (existing && existing.factPayload.serializedString === serialized) {
    return false;
  }
  await writeFactDurably({
    userId,
    factType: "preference",
    subject: PROFILE_SUBJECT,
    serialized,
    version: revision,
  });
  return true;
}

/**
 * Momentum watchdog: when this week's spend tops $20 and runs 1.5x above
 * the trailing 4-week weekly average, write (or bump) a budget_risk fact.
 * Cooling weeks write nothing - the old revisions stay on Walrus as the
 * auditable history of when the watchdog barked.
 */
export const RISK_SUBJECT = "overspend momentum";

async function synthesizeBudgetRisk(
  userId: string,
  txs: Transaction[],
  facts: LearnedFact[],
): Promise<boolean> {
  const now = Date.now();
  const weekStart = now - MS_PER_WEEK;
  const windowStart = now - 5 * MS_PER_WEEK;
  const thisWeek = txs.filter((tx) => tx.occurredAt.getTime() >= weekStart);
  const prior = txs.filter(
    (tx) => tx.occurredAt.getTime() < weekStart && tx.occurredAt.getTime() >= windowStart,
  );
  if (thisWeek.length < 3 || prior.length < 3) return false;
  const sumWeek = thisWeek.reduce((s, tx) => s + Number(tx.amountUsd), 0);
  const avgPrior = prior.reduce((s, tx) => s + Number(tx.amountUsd), 0) / 4;
  if (sumWeek < 20 || sumWeek < avgPrior * 1.5) return false;

  const existing = getFact(facts, "budget_risk", RISK_SUBJECT);
  const existingParsed = existing
    ? parseWatchdogFact(existing.factPayload.serializedString)
    : null;
  const revision = existing
    ? (existingParsed
        ? extractRevision(existingParsed.pattern)
        : existing.version) + 1
    : 1;
  const pattern =
    `weekly spend ${sumWeek.toFixed(2)} USD vs trailing avg ${avgPrior.toFixed(2)} USD, ` +
    `evidence ${thisWeek.length} txs, rev ${revision}`;
  const rule =
    existingParsed?.rule ??
    `flag non-essential purchases until weekly spend cools below ${(avgPrior * 1.2).toFixed(2)} USD`;
  const serialized = serializeWatchdogFact({
    factType: "budget_risk",
    subject: RISK_SUBJECT,
    pattern,
    rule,
  });
  if (existing && existing.factPayload.serializedString === serialized) return false;
  await writeFactDurably({
    userId,
    factType: "budget_risk",
    subject: RISK_SUBJECT,
    serialized,
    version: revision,
  });
  return true;
}

export interface CompactionSummary {
  userId: string;
  merchantsMutated: number;
  profileUpdated: boolean;
  riskUpdated: boolean;
  failures: number;
}

async function compactUser(userId: string): Promise<CompactionSummary> {
  const facts = await db
    .select()
    .from(learnedFacts)
    .where(and(eq(learnedFacts.userId, userId), eq(learnedFacts.status, "active")));
  const txs = (
    await db.select().from(transactions).where(eq(transactions.userId, userId))
  ).filter((tx) => tx.source !== "agent_payment");

  const byMerchant = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = byMerchant.get(tx.merchantName) ?? [];
    list.push(tx);
    byMerchant.set(tx.merchantName, list);
  }

  let merchantsMutated = 0;
  let failures = 0;
  // Per-item isolation: one failed Walrus write (relayer outage, job
  // failure) must not abort the pass. The intent stays in
  // pending_writes and the next pass recovers or retries it.
  for (const [merchant, list] of byMerchant) {
    try {
      if (await compactMerchant(userId, merchant, list, facts)) merchantsMutated++;
    } catch {
      failures++;
    }
  }
  let profileUpdated = false;
  try {
    profileUpdated = await synthesizeProfile(userId, txs, facts);
  } catch {
    failures++;
  }
  let riskUpdated = false;
  try {
    riskUpdated = await synthesizeBudgetRisk(userId, txs, facts);
  } catch {
    failures++;
  }

  if (merchantsMutated > 0 || profileUpdated || riskUpdated) {
    await db
      .insert(syncState)
      .values({ userId, lastMutationAt: new Date() })
      .onConflictDoUpdate({
        target: syncState.userId,
        set: { lastMutationAt: new Date() },
      });
  }
  return { userId, merchantsMutated, profileUpdated, riskUpdated, failures };
}

/** One full pass: recover interrupted writes first, then compact every
 *  known user. Run on a schedule (cron) or on demand; each pass is
 *  idempotent when nothing changed. */
export async function runCompactDream(): Promise<{
  recovery: RecoverySummary;
  users: CompactionSummary[];
}> {
  const recovery = await recoverPendingWrites();
  const allUsers = await db.select({ walletAddress: users.walletAddress }).from(users);
  const summaries: CompactionSummary[] = [];
  for (const user of allUsers) {
    summaries.push(await compactUser(user.walletAddress));
  }
  return { recovery, users: summaries };
}
