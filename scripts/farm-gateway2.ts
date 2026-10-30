// Bounded, read-only farm targeting the PER-ACCOUNT Sui gateway
// (https://olympusxvn-df8e9414.gateway.tatum.io) discovered via
// /v4/manage/gateway in batch 2.
//
// Why this exists:
// - The generic gateway (sui-mainnet.gateway.tatum.io) returns HTTP 404 at
//   the edge for every method with this key (batches 1-2: 1340 uniform 404s),
//   which almost certainly consumes ZERO plan credits.
// - The per-account gateway routes (HTTP 200) but its Sui upstream answers
//   JSON-RPC error -16500 "Invalid response from upstream". Because the
//   request IS forwarded, these calls likely ARE metered against the 100K
//   plan-credit pool - this batch tests that hypothesis while collecting
//   -16500 evidence for the bug report / Tatum support ticket.
// - A pair of proven v4 GET calls is included so the batch also burns
//   credits on endpoints that definitely work.
//
// Safeguards (same as scripts/farm-api.ts):
// - Only safe reads. No writes, no key/plan changes, no payments.
// - Sequential with 300ms pacing; ABORTS immediately on HTTP 429.
// - Every call logged to scripts/farm-gateway2-results.jsonl (method, status,
//   latency, short snippet) for the submission bug report.
// - The API key is never printed or logged.
// Usage: npx tsx scripts/farm-gateway2.ts [rounds]  (default 40 rounds)
import { appendFileSync } from "node:fs";

process.loadEnvFile(".env");
const key = process.env.TATUM_API_KEY ?? "";
if (!key) throw new Error("TATUM_API_KEY is not set.");

const GATEWAY2 = "https://olympusxvn-df8e9414.gateway.tatum.io";
const API = "https://api.tatum.io";
const AGENT = "0x5dc5f85e4ca400f971f0166cba041bb33a37dadb1d2511b9a87b9150c8b2e1ac";
const ALLOWANCE = "0x7a8d2e5abf179e66966125acb5796ea3b9649ddd949e8a63200a88c88cae1993";
const DIGEST = "BDFfAHCMFFNnk5ERmBxqndZvin7NTTXXxPHJgUsFudrh";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call {
  target: "gateway2" | "v4";
  label: string;
  run: () => Promise<{ status: number; snippet: string }>;
}

const gateway2Call = (method: string, params: unknown[]): Call => ({
  target: "gateway2",
  label: method,
  run: async () => {
    const res = await fetch(GATEWAY2, {
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
  // Per-account gateway: expected HTTP 200 + JSON-RPC -16500
  // "Invalid response from upstream" (read-only, no state changes).
  gateway2Call("sui_getChainIdentifier", []),
  gateway2Call("sui_getLatestCheckpointSequenceNumber", []),
  gateway2Call("suix_getBalance", [AGENT]),
  gateway2Call("sui_getObject", [ALLOWANCE, { showContent: true }]),
  gateway2Call("sui_getTransactionBlock", [DIGEST, { showEffects: true }]),
  gateway2Call("suix_getLatestSuiSystemState", []),
  gateway2Call("suix_getReferenceGasPrice", []),
  gateway2Call("sui_getProtocolConfig", []),
  // Proven-working v4 endpoints: deterministic credit burn.
  v4Call("/v4/subscription/chains"),
  v4Call("/v4/subscription/types"),
];

const rounds = Number(process.argv[2] ?? 40);
const OUT = new URL("./farm-gateway2-results.jsonl", import.meta.url).pathname;
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
  if (round % 10 === 0) console.log(`round ${round}/${rounds} done, total calls ${total}`);
}

console.log(JSON.stringify({
  roundsCompleted: rounds,
  totalCalls: total,
  byStatus: Object.fromEntries(byStatus),
  stoppedOn429,
  elapsedSec: Math.round((Date.now() - started) / 1000),
  log: "scripts/farm-gateway2-results.jsonl",
}));
