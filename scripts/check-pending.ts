process.loadEnvFile(".env");
const { getFactJobStatus } = await import("../src/config/walrus.ts");
const { db } = await import("../src/db/client.ts");
const { pendingWrites } = await import("../src/db/schema.ts");
const rows = await db.select().from(pendingWrites);
for (const r of rows) {
  console.log("pending:", r.factType, r.subject, "job:", r.walrusJobId);
  if (r.walrusJobId) {
    console.log("  status:", JSON.stringify(await getFactJobStatus(r.walrusJobId)));
  }
}
