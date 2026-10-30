/**
 * Phase 1 spike: prove the Walrus Memory round-trip on Mainnet and seed
 * the >=10 Mainnet memories the submission requires. Run from repo root:
 *   npx tsx scripts/spike-memwal.ts
 * Writes scripts/spike-memwal-results.json with blob ids for evidence.
 */
import { writeFileSync } from "node:fs";

process.loadEnvFile(".env");

const { rememberFact, recallFacts, serializeWatchdogFact } = await import(
  "../src/config/walrus.ts"
);
import type { WatchdogFactInput } from "../src/config/walrus.ts";

// Demo user = the project owner's main wallet (namespace owner).
const USER_ID = "0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804";

const FACTS: WatchdogFactInput[] = [
  { factType: "merchant_habit", subject: "GrabFood", pattern: "orders lunch 4x per week, avg 12.50 USD per order", rule: "warn when weekly GrabFood spend passes 40 USD" },
  { factType: "merchant_habit", subject: "Highlands Coffee", pattern: "coffee 5x per week, avg 3.20 USD per visit", rule: "suggest a weekly coffee cap of 15 USD" },
  { factType: "merchant_habit", subject: "Circle K", pattern: "late night snacks 3x per week, avg 4.75 USD", rule: "include in the weekly discretionary spend report" },
  { factType: "budget_risk", subject: "dining out", pattern: "weekend dining spikes to 85 USD, about 2x the weekday average", rule: "alert when a single dining transaction exceeds 50 USD" },
  { factType: "budget_risk", subject: "online shopping", pattern: "Shopee orders cluster at month end, avg 120 USD per month", rule: "flag months where shopping passes 100 USD before day 25" },
  { factType: "budget_risk", subject: "transport", pattern: "ride hailing reaches 60 USD in rainy weeks", rule: "alert when weekly transport spend passes 55 USD" },
  { factType: "payment_rule", subject: "shared expenses", pattern: "dinner bills are split equally with group members", rule: "always split group meals equally unless told otherwise" },
  { factType: "payment_rule", subject: "subscriptions", pattern: "Netflix 11.99 USD renews on the 15th each month", rule: "remind 2 days before each subscription renewal" },
  { factType: "payment_rule", subject: "agent autopay", pattern: "agent may auto pay approved expense splits onchain", rule: "require human approval for any agent payment above 50 USD per transaction" },
  { factType: "preference", subject: "currency display", pattern: "user wants every amount shown in USD", rule: "never show VND or SUI amounts without the USD equivalent" },
  { factType: "preference", subject: "notifications", pattern: "user prefers one daily summary at 20:00", rule: "batch non urgent alerts into the daily summary" },
];

const results: Array<{ serialized: string; blobId: string; jobId: string }> = [];
for (const fact of FACTS) {
  const serialized = serializeWatchdogFact(fact);
  const { blobId, jobId } = await rememberFact(USER_ID, serialized);
  results.push({ serialized, blobId, jobId });
  console.log(`OK  ${blobId}  ${serialized}`);
}

console.log(`\nStored ${results.length} memories. Recall checks:`);
for (const query of ["coffee spending habits", "agent payment approval limit"]) {
  const hits = await recallFacts(USER_ID, query, 3);
  console.log(`\nQ: ${query}`);
  for (const hit of hits) console.log(`  - ${hit.text ?? JSON.stringify(hit).slice(0, 120)}`);
}

writeFileSync(
  new URL("./spike-memwal-results.json", import.meta.url),
  JSON.stringify({ userId: USER_ID, storedAt: new Date().toISOString(), results }, null, 2),
);
console.log("\nSaved scripts/spike-memwal-results.json");
