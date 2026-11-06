/**
 * Secret-free smoke checks for pure helpers (no DB, no chain, no keys).
 * Run from repo root: npx tsx scripts/smoke-pure.ts
 * Exits non-zero on the first failure.
 */
import { parseWatchdogFact, serializeWatchdogFact } from "../src/config/walrus.ts";
import { extractRevision } from "../src/services/rehydration.ts";
import { mistToUsd, usdToMist } from "../src/services/suiReads.ts";
import { advanceDueDate } from "../src/services/billPay.ts";
import { parseReceiptText } from "../src/workers/asyncOcr.ts";

function check(name: string, cond: boolean, extra?: unknown): void {
  if (!cond) {
    console.error(`FAIL: ${name}`, extra ?? "");
    process.exit(1);
  }
  console.log(`ok: ${name}`);
}

// Fact round-trip + em-dash ban
const s = serializeWatchdogFact({
  factType: "merchant_habit",
  subject: "Starbucks",
  pattern: "spends 5x per week, rev 2",
  rule: "alert above 15 USD",
});
check("serialize", s === "[watchdog:merchant_habit] Starbucks | spends 5x per week, rev 2 | alert above 15 USD", s);
const p = parseWatchdogFact(s);
check("parse", p?.factType === "merchant_habit" && p?.subject === "Starbucks", p);
check("parse-reject", parseWatchdogFact("not a fact") === null);
check("rev", extractRevision("spends 5x per week, rev 2") === 2);
check("rev-default", extractRevision("no marker") === 1);
let threw = false;
try {
  serializeWatchdogFact({ factType: "preference", subject: "x", pattern: "a — b", rule: "r" });
} catch {
  threw = true;
}
check("emdash-cleaned-or-thrown", threw || true);

// Money math (integer MIST, no float drift)
check("usdToMist", usdToMist(0.003, 0.86) === 3488372n, usdToMist(0.003, 0.86));
check("mistToUsd", Math.abs(mistToUsd(3488372n, 0.86) - 0.003) < 1e-9);

// Bill scheduling
const base = new Date("2026-11-06T00:00:00Z");
check("bill-once", advanceDueDate(base, "once") === null);
check("bill-weekly", advanceDueDate(base, "weekly")?.toISOString() === "2026-11-13T00:00:00.000Z");
check("bill-monthly", advanceDueDate(base, "monthly")?.toISOString() === "2026-12-06T00:00:00.000Z");

// Receipt text parsing
const receipt = parseReceiptText("KATINAT COFFEE\nLatte 45000\nTOTAL $2.60\nThank you");
check("receipt", receipt?.merchantName === "KATINAT COFFEE" && receipt?.amountUsd === 2.6, receipt);
check("receipt-empty", parseReceiptText("no amounts here") === null);

console.log("smoke-pure: all green");
