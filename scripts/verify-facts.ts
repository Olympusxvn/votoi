// Read-only: print pending_writes count and every learned fact with its
// Walrus blob id, so a human can confirm what has landed on Mainnet.
process.loadEnvFile(".env");
const { db } = await import("../src/db/client.ts");
const { learnedFacts, pendingWrites } = await import("../src/db/schema.ts");
const pending = await db.select().from(pendingWrites);
console.log("pending_writes rows:", pending.length);
const rows = await db.select().from(learnedFacts);
for (const r of rows) {
  console.log(
    r.factType, "|", r.subject,
    "| blob:", r.walrusBlobId ? r.walrusBlobId.slice(0, 12) + "..." : "NONE",
    "| status:", r.status, "| v" + r.version,
    "|", (r.factPayload?.serializedString ?? "").slice(0, 120),
  );
}
