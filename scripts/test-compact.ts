/**
 * Live test for the upgraded compactDream: durable writes, evidence
 * counts, the mental-model profile fact, and pending-write recovery.
 * Run from repo root: npx tsx scripts/test-compact.ts
 */
process.loadEnvFile(".env");

const { postChat } = await import("../src/api/chat.ts");
const { runCompactDream, recoverPendingWrites } = await import(
  "../src/workers/compactDream.ts"
);
const { db } = await import("../src/db/client.ts");
const { learnedFacts, pendingWrites } = await import("../src/db/schema.ts");
const { recallFacts, factIdempotencyKey } = await import("../src/config/walrus.ts");
const { and, eq } = await import("drizzle-orm");

const MAIN = "0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804";

// 1. Seed GrabFood to 6 transactions (one exists from the Phase 2 test).
for (let i = 0; i < 5; i++) {
  await postChat({ user_id: MAIN, session_id: "compact-test", message: "spent 12.50 at GrabFood" });
}
console.log("seeded: GrabFood now has 6 txs");

// 2. One compaction pass.
const result = await runCompactDream();
console.log("compaction:", JSON.stringify(result));

const facts = await db
  .select()
  .from(learnedFacts)
  .where(and(eq(learnedFacts.userId, MAIN), eq(learnedFacts.status, "active")));
const grab = facts.find((f) => f.subject === "GrabFood");
const profile = facts.find((f) => f.subject === "spending profile");
console.log("GrabFood fact:", grab?.factPayload.serializedString);
console.log("GrabFood blob:", grab?.walrusBlobId ? "set" : "MISSING");
console.log("Profile fact:", profile?.factPayload.serializedString);
console.log("Profile blob:", profile?.walrusBlobId ? "set" : "MISSING");
const pendingAfter = await db.select().from(pendingWrites);
console.log("pending_writes after pass:", pendingAfter.length);

// 3. The new facts must be recallable from Walrus itself (skipped
//    gracefully while the relayer is having an outage).
try {
  const recalled = await recallFacts(MAIN, "GrabFood spending evidence", 5);
  const hit = recalled.some((m) =>
    String((m as unknown as Record<string, unknown>).text ?? "").includes("evidence 6 txs"),
  );
  console.log("walrus recall sees evidence fact:", hit);
} catch {
  console.log("walrus recall unavailable right now (relayer outage) - skipping check 3");
}

// 4. Recovery: a dead job id must be dropped; a no-job row whose content
//    matches an already-written fact must finalize via key replay.
const notif = facts.find((f) => f.subject === "notifications");
if (!notif) throw new Error("notifications fact missing - cannot run recovery test");
await db.insert(pendingWrites).values({
  userId: MAIN,
  factType: "preference",
  subject: "ghost",
  serialized: "[watchdog:preference] ghost | never submitted, rev 1 | ignore",
  idempotencyKey: factIdempotencyKey(MAIN, "ghost-content"),
  version: 1,
  walrusJobId: "job-that-does-not-exist",
});
await db.insert(pendingWrites).values({
  userId: MAIN,
  factType: notif.factType,
  subject: notif.subject,
  serialized: notif.factPayload.serializedString,
  idempotencyKey: factIdempotencyKey(MAIN, notif.factPayload.serializedString),
  version: notif.version,
  walrusJobId: null,
});
const recovery = await recoverPendingWrites();
console.log("recovery:", JSON.stringify(recovery));
const pendingFinal = await db.select().from(pendingWrites);
console.log("pending_writes at end:", pendingFinal.length);
