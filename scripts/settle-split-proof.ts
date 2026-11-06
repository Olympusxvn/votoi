/**
 * MPP proof: settle a 2-recipient split ($0.003 total) through the
 * production allowance in one atomic PTB, via the active chain
 * transport (Tatum gRPC first, public fallback).
 *
 * DRY_RUN=1 stops after the simulation gate (no signature, no spend).
 * Run from repo root: npx tsx scripts/settle-split-proof.ts
 *
 * Safety rails (all hard asserts, fail before anything is signed):
 * - total is exactly $0.003 to exactly [owner, spender]
 * - total MIST <= 5.5M, allowance remaining + funder balance cover it
 * - spender holds >= 3M MIST for gas
 * - the exact PTB builds and simulates ok
 * - the GraphQL cross-check parser is proven on a recent digest first
 */
import { writeFileSync } from "node:fs";

process.loadEnvFile(".env");

const { getAgentSpenderAddress, spendFromAllowance } = await import("../src/services/agentPayments.ts");
const { getChainOps, graphqlTxStatus, probeTransports, suiGraphql } = await import("../src/config/chainTransport.ts");
const { getAllowanceState, getSuiBalanceMist, getSuiUsdRate, mistToUsd, usdToMist } = await import("../src/services/suiReads.ts");
const { Transaction } = await import("@mysten/sui/transactions");

const ALLOWANCE_ID = "0x7a8d2e5abf179e66966125acb5796ea3b9649ddd949e8a63200a88c88cae1993";
const FUNDER = "0x5dc5f85e4ca400f971f0166cba041bb33a37dadb1d2511b9a87b9150c8b2e1ac";
const OWNER = "0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804";
const TOTAL_USD = 0.003;
const MAX_MIST = 5_500_000n;
const MIN_SPENDER_GAS_MIST = 3_000_000n;
const DRY = process.env.DRY_RUN === "1";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`PREFLIGHT FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`preflight ok: ${msg}`);
}

const spender = getAgentSpenderAddress();
const splits = [
  { address: OWNER, amountUsd: 0.002 },
  { address: spender, amountUsd: 0.001 },
];
assert(
  splits.reduce((s, r) => s + r.amountUsd, 0) === TOTAL_USD && splits.length === 2,
  `split plan is exactly $${TOTAL_USD.toFixed(3)} to owner + spender`,
);

const probe = await probeTransports();
console.log(`transports: tatumJson=${probe.tatumJson} tatumGrpc=${probe.tatumGrpc} public=${probe.public} active=${probe.active}`);
assert(probe.active === "tatum-grpc" || probe.active === "public" || probe.active === "tatum", "a chain transport is up");

const rate = await getSuiUsdRate();
assert(rate !== null && rate > 0, `live SUI/USD rate available (${rate})`);
const mistAmounts = splits.map((s) => usdToMist(s.amountUsd, rate as number));
const totalMist = mistAmounts.reduce((s, m) => s + m, 0n);
console.log(`total: ${totalMist} MIST at $${rate}/SUI`);
assert(totalMist <= MAX_MIST, `total ${totalMist} MIST within ${MAX_MIST} cap`);

const allowance = await getAllowanceState(ALLOWANCE_ID);
assert(allowance !== null, "production allowance readable");
assert(allowance?.spender === spender, "allowance names this spender");
assert(
  allowance?.remainingMist === null || (allowance?.remainingMist as bigint) >= totalMist,
  `allowance remaining ${allowance?.remainingMist} covers ${totalMist}`,
);
assert(
  allowance?.expirationMs === null || (allowance?.expirationMs as number) > Date.now(),
  "allowance unexpired",
);
const funderBal = await getSuiBalanceMist(FUNDER);
assert(funderBal >= totalMist, `funder balance ${funderBal} covers ${totalMist}`);
const spenderBal = await getSuiBalanceMist(spender);
assert(spenderBal >= MIN_SPENDER_GAS_MIST, `spender gas balance ${spenderBal} covers one tx`);

// Prove the GraphQL cross-check parser on a recent digest first.
const recent = await suiGraphql<{ checkpoints?: { nodes?: Array<{ transactionBlocks?: { nodes?: Array<{ digest?: string }> } }> } }>(
  `{ checkpoints(last: 1) { nodes { transactions(first: 1) { nodes { digest } } } } }`,
  {},
);
const recentDigest = recent.checkpoints?.nodes?.[0]?.transactions?.nodes?.[0]?.digest;
assert(typeof recentDigest === "string", "recent digest fetched for parser check");
const recentStatus = await graphqlTxStatus(recentDigest as string);
assert(recentStatus === "success", `cross-check parser proven (${(recentDigest as string).slice(0, 12)}... -> ${recentStatus})`);

// Pre-flight: build + simulate the exact spend (no signature).
const ops = await getChainOps();
const tx = new Transaction();
tx.setSender(spender);
const balance = tx.balance({ allowance: { objectId: ALLOWANCE_ID, funder: FUNDER }, balance: totalMist });
const coin = tx.moveCall({
  target: "0x2::coin::from_balance",
  typeArguments: ["0x2::sui::SUI"],
  arguments: [balance],
});
const parts = tx.splitCoins(coin, mistAmounts);
splits.forEach((r, i) => tx.transferObjects([parts[i]], r.address));
tx.transferObjects([coin], splits[0].address); // zero remainder or PTB validation fails
tx.setGasBudget(6_000_000n);
tx.setGasPrice(await ops.getGasPrice());
const preBytes = await ops.buildTx(tx);
const preSim = await ops.simulateTx(preBytes);
assert(preSim.ok, `exact PTB simulates ok via ${ops.transport} (gas ${preSim.gasMist} MIST)`);
console.log(`estimated fee: $${mistToUsd(preSim.gasMist, rate as number).toFixed(4)} USD`);

if (DRY) {
  console.log("DRY_RUN=1: stopping before signature. No money moved.");
  process.exit(0);
}

const result = await spendFromAllowance({
  allowanceId: ALLOWANCE_ID,
  funder: FUNDER,
  recipients: splits.map((s, i) => ({ address: s.address, amountMist: mistAmounts[i] })),
  totalUsd: TOTAL_USD,
});
console.log(`SETTLED via ${result.transport}: digest ${result.digest}`);
console.log(`suiscan: https://suiscan.xyz/mainnet/tx/${result.digest}`);

const record = {
  standard: "mpp",
  recipients: splits,
  totalUsd: TOTAL_USD,
  totalMist: totalMist.toString(),
  gasMist: result.gasMist.toString(),
  gasUsd: mistToUsd(result.gasMist, rate as number),
  digest: result.digest,
  transport: result.transport,
  allowanceId: ALLOWANCE_ID,
  funder: FUNDER,
  at: new Date().toISOString(),
};
writeFileSync(new URL("./settle-split-results.json", import.meta.url), JSON.stringify(record, null, 2));
console.log("Saved scripts/settle-split-results.json");
console.log("--- ledger SQL (run where DATABASE_URL lives, after db:push 0003) ---");
console.log(
  `INSERT INTO agent_payments (user_id, standard, recipients, total_usd, status, tx_hash, gas_usd, transport, settled_at) VALUES ('${FUNDER}', 'mpp', '${JSON.stringify(splits.map((s) => ({ address: s.address, amountUsd: s.amountUsd })))}', '0.0030', 'settled', '${result.digest}', '${mistToUsd(result.gasMist, rate as number).toFixed(4)}', '${result.transport}', now());`,
);
console.log(
  `INSERT INTO transactions (user_id, merchant_name, amount_usd, source, tx_hash) VALUES ('${FUNDER}', 'agent mpp split', '0.0030', 'agent_payment', '${result.digest}');`,
);
process.exit(0);
