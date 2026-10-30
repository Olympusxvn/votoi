// Bounded, read-only API farm for the 100K plan-credit pool + bug evidence.
// - Only safe reads: Sui gateway JSON-RPC methods and Tatum v4 GET endpoints.
// - No writes, no key/plan changes, no payments, no subscriptions created.
// - Sequential with a delay; ABORTS immediately on HTTP 429 (rate limit).
// - Every call is logged (method, status, latency, short error snippet) to
//   scripts/farm-api-results.jsonl for the submission bug report.
// - The API key is never printed or logged.
// Usage: npx tsx scripts/farm-api.ts [rounds]  (default 20 rounds)
import { appendFileSync } from "node:fs";

process.loadEnvFile(".env");
const key = process.env.TATUM_API_KEY ?? "";
if (!key) throw new Error("TATUM_API_KEY is not set.");

const GATEWAY = "https://sui-mainnet.gateway.tatum.io";
const API = "https://api.tatum.io";
const AGENT = "0x5dc5f85e4ca400f971f0166cba041bb33a37dadb1d2511b9a87b9150c8b2e1ac";
const ALLOWANCE = "0x7a8d2e5abf179e66966125acb5796ea3b9649ddd949e8a63200a88c88cae1993";
const DIGEST = "BDFfAHCMFFNnk5ERmBxqndZvin7NTTXXxPHJgUsFudrh";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call {
  target: "gateway" | "v4";
  label: string;
  run: () => Promise<{ status: number; snippet: string }>;
}

const gatewayCall = (method: string, params: unknown[]): Call => ({
  target: "gateway",
  label: method,
  run: async () => {
    const res = await fetch(GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return { status: res.status, snippet: text.slice(0, 160) };
  },
});

const v4Call = (path: string): Call => ({
  target: "v4",
  label: `GET ${path}`,
  run: async () => {
    const res = await fetch(`${API}${path}`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return { status: res.status, snippet: text.slice(0, 160) };
  },
});

const CALLS: Call[] = [
  gatewayCall("sui_getChainIdentifier", []),
  gatewayCall("sui_getLatestCheckpointSequenceNumber", []),
  gatewayCall("suix_getBalance", [AGENT]),
  gatewayCall("sui_getObject", [ALLOWANCE, { showContent: true }]),
  gatewayCall("suix_getOwnedObjects", [
    AGENT,
    { filter: { StructType: "0x2::allowance::AllowanceCap" }, options: { showContent: true } },
    null,
    5,
  ]),
  gatewayCall("sui_getTransactionBlock", [DIGEST, { showEffects: true }]),
  gatewayCall("sui_getNormalizedMoveFunction", ["0x2", "allowance", "new"]),
  gatewayCall("sui_getTotalTransactionBlocks", []),
  gatewayCall("suix_getReferenceGasPrice", []),
  gatewayCall("sui_getProtocolConfig", []),
  gatewayCall("suix_getLatestSuiSystemState", []),
  gatewayCall("suix_getAllBalances", [AGENT]),
  v4Call("/v4/subscription/chains"),
  v4Call("/v4/subscription/types"),
  // Probes: dashboard management endpoints (may be session-only; any
  // status is recorded as evidence, not counted as farm volume).
  v4Call("/v4/manage/limits"),
  v4Call("/v4/manage/endpoint"),
  v4Call("/v4/manage/gateway"),
];

const rounds = Number(process.argv[2] ?? 20);
const OUT = new URL("./farm-api-results.jsonl", import.meta.url).pathname;
const byStatus = new Map<number | string, number>();
let total = 0;
let stoppedOn429 = false;
const started = Date.now();

outer: for (let round = 1; round <= rounds; round++) {
  for (const call of CALLS) {
    const t0 = Date.now();
    try {
      const { status, snippet } = await call.run();
      total++;
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      appendFileSync(
        OUT,
        JSON.stringify({ ts: new Date().toISOString(), round, target: call.target, label: call.label, status, ms: Date.now() - t0, snippet }) + "\n",
      );
      if (status === 429) {
        stoppedOn429 = true;
        console.log(`STOPPED on 429 at round ${round} (${call.target} ${call.label}).`);
        break outer;
      }
    } catch (e) {
      total++;
      byStatus.set("error", (byStatus.get("error") ?? 0) + 1);
      appendFileSync(
        OUT,
        JSON.stringify({ ts: new Date().toISOString(), round, target: call.target, label: call.label, status: "error", ms: Date.now() - t0, snippet: String(e).slice(0, 160) }) + "\n",
      );
    }
    await sleep(300);
  }
  if (round % 5 === 0) console.log(`round ${round}/${rounds} done, total calls ${total}`);
}

console.log(JSON.stringify({
  roundsCompleted: rounds,
  totalCalls: total,
  byStatus: Object.fromEntries(byStatus),
  stoppedOn429,
  elapsedSec: Math.round((Date.now() - started) / 1000),
  log: "scripts/farm-api-results.jsonl",
}));
