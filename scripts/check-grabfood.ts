// Read-only: list GrabFood ledger rows with timestamps to see when the
// evidence count changed.
process.loadEnvFile(".env");
const { db } = await import("../src/db/client.ts");
const { transactions } = await import("../src/db/schema.ts");
const { eq, asc } = await import("drizzle-orm");
const rows = await db
  .select()
  .from(transactions)
  .where(eq(transactions.merchantName, "GrabFood"))
  .orderBy(asc(transactions.createdAt));
console.log("GrabFood txs:", rows.length);
for (const r of rows) {
  console.log(r.createdAt?.toISOString(), "|", r.amountUsd, "|", r.source, "|", r.txId.slice(0, 8));
}
