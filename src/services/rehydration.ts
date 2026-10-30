import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { learnedFacts, syncState, users, type LearnedFact } from "../db/schema";
import {
  parseWatchdogFact,
  recallFacts,
  restoreUserMemory,
} from "../config/walrus";

/**
 * Walrus-to-Postgres rehydration (RULE.md section 4, PRD workflow 2).
 *
 * Postgres is a volatile cache; Walrus Memory Mainnet is canonical.
 * When the cache is empty the chat pipeline must halt and rebuild from
 * Walrus before answering:
 *   1. restore(namespace) re-indexes the user's on-chain blobs into the
 *      MemWal relayer (restore returns counts only, not the texts).
 *   2. Broad per-type recall queries fetch the fact texts back.
 *   3. Facts are deduplicated per (fact_type, subject) slot keeping the
 *      highest embedded revision: restore() stamps restored memories
 *      with the restore time as created_at (MemWal issue #1060), so
 *      created_at can NEVER order versions after a restore - the
 *      "rev N" suffix at the end of the pattern segment can.
 */

const REV_PATTERN = /\brev\s+(\d+)\s*$/i;

/** Revision embedded in a fact pattern; 1 when the fact predates the
 *  rev convention (all such facts are first versions). */
export function extractRevision(pattern: string): number {
  const match = REV_PATTERN.exec(pattern);
  return match ? Number(match[1]) : 1;
}

/** One broad recall seed per fact type: recall is semantic search, so a
 *  full rebuild asks each type's question and merges the answers. */
const SEED_QUERIES: Array<{ factType: string; query: string }> = [
  { factType: "merchant_habit", query: "merchant spending habits shops stores restaurants coffee" },
  { factType: "budget_risk", query: "budget risk overspending alerts weekly monthly limits" },
  { factType: "payment_rule", query: "payment rules bill splitting subscriptions agent autopay approval" },
  { factType: "preference", query: "user preferences currency display notifications summary" },
];

export async function ensureUser(userId: string): Promise<void> {
  await db.insert(users).values({ walletAddress: userId }).onConflictDoNothing();
}

export async function getCachedFacts(userId: string): Promise<LearnedFact[]> {
  return db
    .select()
    .from(learnedFacts)
    .where(and(eq(learnedFacts.userId, userId), eq(learnedFacts.status, "active")));
}

export interface RehydrationResult {
  source: "cache" | "walrus";
  facts: LearnedFact[];
  restoredFromWalrus: number | null;
  /** True when the Walrus rebuild failed (relayer outage) and the
   *  caller got an empty, degraded context instead of an exception:
   *  a dead chat endpoint during a relayer incident helps no one, and
   *  the agent labels its answer accordingly. */
  degraded?: boolean;
}

export async function rehydrateUser(userId: string): Promise<RehydrationResult> {
  await ensureUser(userId);
  const cached = await getCachedFacts(userId);
  if (cached.length > 0) {
    return { source: "cache", facts: cached, restoredFromWalrus: null };
  }

  // Cache miss: halt and rebuild from the canonical tier.
  let restore;
  try {
    restore = await restoreUserMemory(userId);
  } catch {
    return { source: "cache", facts: [], restoredFromWalrus: null, degraded: true };
  }

  interface SlotWinner {
    factType: string;
    subject: string;
    serialized: string;
    revision: number;
    blobId: string | null;
  }
  const winners = new Map<string, SlotWinner>();
  try {
    for (const seed of SEED_QUERIES) {
      const memories = await recallFacts(userId, seed.query, 25);
    for (const memory of memories) {
      const raw = memory as unknown as Record<string, unknown>;
      const text = typeof raw.text === "string" ? raw.text : null;
      if (!text) continue;
      const fact = parseWatchdogFact(text);
      if (!fact) continue;
      const revision = extractRevision(fact.pattern);
      const slotKey = `${fact.factType}:${fact.subject.toLowerCase()}`;
      const current = winners.get(slotKey);
      if (!current || revision > current.revision) {
        winners.set(slotKey, {
          factType: fact.factType,
          subject: fact.subject,
          serialized: fact.serialized,
          revision,
          blobId:
            typeof raw.blob_id === "string"
              ? raw.blob_id
              : typeof raw.blobId === "string"
                ? raw.blobId
                : null,
        });
      }
    }
    }
  } catch {
    return { source: "cache", facts: [], restoredFromWalrus: null, degraded: true };
  }

  for (const winner of winners.values()) {
    await db
      .insert(learnedFacts)
      .values({
        userId,
        factType: winner.factType,
        subject: winner.subject,
        factPayload: { serializedString: winner.serialized },
        walrusBlobId: winner.blobId,
        version: winner.revision,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [learnedFacts.userId, learnedFacts.factType, learnedFacts.subject],
        set: {
          factPayload: { serializedString: winner.serialized },
          walrusBlobId: winner.blobId,
          version: winner.revision,
          status: "active",
        },
      });
  }

  await db
    .insert(syncState)
    .values({
      userId,
      lastRehydratedAt: new Date(),
      walrusFactCount: winners.size,
    })
    .onConflictDoUpdate({
      target: syncState.userId,
      set: { lastRehydratedAt: new Date(), walrusFactCount: winners.size },
    });

  const facts = await getCachedFacts(userId);
  return { source: "walrus", facts, restoredFromWalrus: restore.restored };
}

/**
 * Demo support: drop the local cache for one user (learned facts and
 * sync bookkeeping) so the next chat visibly rebuilds from Walrus.
 * Walrus itself is untouched - that is the whole point of the demo.
 */
export async function wipeCache(
  userId: string,
): Promise<{ deletedFacts: number }> {
  const deleted = await db
    .delete(learnedFacts)
    .where(eq(learnedFacts.userId, userId))
    .returning({ factId: learnedFacts.factId });
  await db
    .insert(syncState)
    .values({ userId, lastRehydratedAt: null, walrusFactCount: 0 })
    .onConflictDoUpdate({
      target: syncState.userId,
      set: { lastRehydratedAt: null, walrusFactCount: 0 },
    });
  return { deletedFacts: deleted.length };
}
