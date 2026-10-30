import { createHash } from "node:crypto";
import { MemWal } from "@mysten-incubation/memwal";
import type { RecallMemory, RestoreResult } from "@mysten-incubation/memwal";
import type { FactType } from "../db/schema";

/**
 * Walrus Memory (MemWal) client: the canonical source of truth tier.
 *
 * Real SDK surface (@mysten-incubation/memwal), verified against the
 * installed package and the official quickstart:
 * - MemWal.create({ key, accountId, serverUrl, namespace })
 * - remember() is asynchronous: it returns a job_id, the relayer then
 *   encrypts, embeds and uploads the blob to Walrus. waitForRememberJob()
 *   resolves with the final blob_id.
 * - recall() is a semantic search, not a dump. There is NO update or
 *   delete: memory is append-only, so fact mutation means writing a new
 *   version and letting "newest wins" (blob created_at + recency-weighted
 *   recall) supersede the old one. Postgres tracks the version counter.
 * - restore(namespace) re-indexes on-chain blobs into the relayer, which
 *   is the first step of a cold rehydration. Known issue (MemWal #1060):
 *   restore() stamps restored memories with the restore time as
 *   created_at, so after a restore the mutation pipeline must order
 *   versions by the revision embedded in the fact text (Step 4
 *   convention: the pattern segment ends with "rev N"), never by
 *   created_at alone.
 *
 * Multi-tenancy: one delegate key and one MemWal account serve the whole
 * app; every user gets an isolated namespace derived from their wallet.
 */

const DEFAULT_SERVER_URL = "https://relayer.memory.walrus.xyz";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const walrusConfig = {
  serverUrl: process.env.MEMWAL_SERVER_URL ?? DEFAULT_SERVER_URL,
  accountId: process.env.MEMWAL_ACCOUNT_ID ?? "",
};

let client: MemWal | null = null;

export function getMemWal(): MemWal {
  if (!client) {
    client = MemWal.create({
      key: requireEnv("MEMWAL_PRIVATE_KEY"),
      accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
      serverUrl: walrusConfig.serverUrl,
      namespace: "votoi",
    });
  }
  return client;
}

/** Per-user memory namespace: "votoi-" + wallet address without the 0x. */
export function userNamespace(userId: string): string {
  return `votoi-${userId.replace(/^0x/, "")}`;
}

// ------------------------------------------------------ fact serialization

/** Reserved subject of the synthesized mental-model fact (one per user,
 *  maintained by workers/compactDream.ts, read first by the agent). */
export const PROFILE_SUBJECT = "spending profile";

export interface WatchdogFactInput {
  factType: FactType;
  subject: string;
  pattern: string;
  rule: string;
}

export interface WatchdogFact extends WatchdogFactInput {
  serialized: string;
}

/** Fields may not contain the delimiter or dash characters: pipes would
 *  corrupt parsing, em-dashes are banned outright (RULE.md Boundary 3). */
function cleanField(value: string): string {
  return value
    .replace(/[—–]/g, "-")
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Serialize a fact to the canonical Walrus string:
 *   [watchdog:fact_type] subject | pattern | rule
 * Throws rather than ever emitting an em-dash; the Postgres CHECK
 * constraint on learned_facts is the second line of defense.
 */
export function serializeWatchdogFact(input: WatchdogFactInput): string {
  const serialized =
    `[watchdog:${input.factType}] ${cleanField(input.subject)}` +
    ` | ${cleanField(input.pattern)} | ${cleanField(input.rule)}`;
  if (serialized.includes("—")) {
    throw new Error("Serialized fact must not contain an em-dash.");
  }
  return serialized;
}

const FACT_PATTERN = /^\[watchdog:([a-z_]+)\]\s+([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;

export function parseWatchdogFact(text: string): WatchdogFact | null {
  const match = FACT_PATTERN.exec(text.trim());
  if (!match) return null;
  return {
    factType: match[1] as FactType,
    subject: match[2].trim(),
    pattern: match[3].trim(),
    rule: match[4].trim(),
    serialized: text.trim(),
  };
}

// ------------------------------------------------------------ memory ops

export interface RememberFactResult {
  blobId: string;
  jobId: string;
}

export interface SubmittedFact {
  jobId: string;
  idempotencyKey: string;
}

/** The deterministic idempotency key for a fact: sha256 of namespace +
 *  content. The same content always maps to the same key, so replaying
 *  a submission after a crash collapses onto the original relayer job
 *  instead of paying for a duplicate blob. */
export function factIdempotencyKey(userId: string, serialized: string): string {
  return createHash("sha256")
    .update(`${userNamespace(userId)}:${serialized}`)
    .digest("hex");
}

/**
 * Submit one serialized fact to Walrus Memory and return as soon as the
 * relayer accepts the job - WITHOUT waiting for the Mainnet receipt.
 * Callers that need crash safety persist the returned job_id before
 * awaiting (see workers/compactDream.ts and the pending_writes table).
 */
export async function submitFact(
  userId: string,
  serialized: string,
): Promise<SubmittedFact> {
  if (serialized.includes("—")) {
    throw new Error("Refusing to store a fact containing an em-dash on Walrus.");
  }
  const namespace = userNamespace(userId);
  const idempotencyKey = factIdempotencyKey(userId, serialized);
  const accepted = await getMemWal().remember(serialized, namespace, {
    idempotencyKey,
  });
  return { jobId: accepted.job_id, idempotencyKey };
}

/** Wait for an accepted remember job to produce its Walrus blob id. */
export async function awaitFact(jobId: string): Promise<string> {
  const done = await getMemWal().waitForRememberJob(jobId);
  return done.blob_id;
}

/** Point status check for one remember job (recovery path - the SDK's
 *  getRememberStatus; statuses: pending, running, uploaded, done,
 *  failed, not_found). */
export async function getFactJobStatus(jobId: string) {
  return getMemWal().getRememberStatus(jobId);
}

/**
 * Commit one serialized fact to Walrus Memory Mainnet and wait until the
 * blob exists. Only after this resolves may a fact be marked "learned"
 * in Postgres (RULE.md Boundary 2). Composition of submitFact +
 * awaitFact for callers that do not need the durable pipeline.
 */
export async function rememberFact(
  userId: string,
  serialized: string,
): Promise<RememberFactResult> {
  const { jobId } = await submitFact(userId, serialized);
  const blobId = await awaitFact(jobId);
  return { blobId, jobId };
}

/** Semantic recall inside one user's namespace, best matches first. */
export async function recallFacts(
  userId: string,
  query: string,
  limit = 10,
): Promise<RecallMemory[]> {
  const result = await getMemWal().recall({
    query,
    limit,
    namespace: userNamespace(userId),
  });
  return result.results;
}

/** Re-index a user's on-chain blobs into the relayer (cold rehydration). */
export async function restoreUserMemory(userId: string): Promise<RestoreResult> {
  return getMemWal().restore(userNamespace(userId));
}
