/**
 * Phase 1 spike v2: prove the Sui allowance spend path on Mainnet
 * through the Tatum gateway.
 *   funder  = agent wallet (VOTOI_AGENT_SUI_ADDRESS)
 *   spender = MemWal delegate address (MEMWAL_PRIVATE_KEY)
 *   payee   = project owner's main wallet
 * Resilience notes (learned from v1): building a PTB through the
 * gateway makes the SDK resolver fire several RPCs - free-plan 429s
 * and one truncated 150 KB system-state response killed v1 before
 * anything was sent. v2 pre-sets gas budget + price and retries the
 * read-only build step; execution itself happens exactly once.
 * Run from repo root: npx tsx scripts/spike-allowance.ts
 */
import { writeFileSync } from "node:fs";

process.loadEnvFile(".env");

const { getTatumSuiClient } = await import("../src/services/agentPayments.ts");
const { Transaction } = await import("@mysten/sui/transactions");
const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const { toBase64 } = await import("@mysten/bcs");

type Tx = InstanceType<typeof Transaction>;
type Kp = InstanceType<typeof Ed25519Keypair>;

const client = getTatumSuiClient();
const funder = Ed25519Keypair.fromSecretKey(process.env.VOTOI_AGENT_SUI_PRIVATE_KEY!);
const spender = Ed25519Keypair.fromSecretKey(
  Buffer.from(process.env.MEMWAL_PRIVATE_KEY!, "hex"),
);
const funderAddress = funder.toSuiAddress();
const spenderAddress = spender.toSuiAddress();
const PAYEE = "0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804";
const GAS_BUDGET = 6_000_000n;
const gasPrice = BigInt(await client.getReferenceGasPrice());
console.log(`reference gas price: ${gasPrice}`);

async function buildWithRetry(tx: Tx): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await tx.build({ client });
    } catch (err) {
      lastErr = err;
      console.log(`build attempt ${attempt} failed: ${(err as Error).message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

async function execute(tx: Tx, signer: Kp) {
  tx.setGasBudget(GAS_BUDGET);
  tx.setGasPrice(gasPrice);
  const bytes = await buildWithRetry(tx);
  const { signature } = await signer.signTransaction(bytes);
  const res = await client.executeTransactionBlock({
    transactionBlock: toBase64(bytes),
    signature,
    options: { showEffects: true, showObjectChanges: true },
  });
  const done = await client.waitForTransaction({
    digest: res.digest,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (done.effects?.status?.status !== "success") {
    throw new Error(`tx ${res.digest} failed: ${JSON.stringify(done.effects?.status)}`);
  }
  return done;
}

// 0. Top up the spender with gas if needed.
const spenderBalance = BigInt(
  (await client.getBalance({ owner: spenderAddress })).totalBalance,
);
console.log(`spender SUI balance: ${spenderBalance}`);
if (spenderBalance < 8_000_000n) {
  const topUp = new Transaction();
  topUp.setSender(funderAddress);
  const [coin] = topUp.splitCoins(topUp.gas, [12_000_000n]);
  topUp.transferObjects([coin], spenderAddress);
  const r = await execute(topUp, funder);
  console.log(`topped up spender, digest ${r.digest}`);
}

// 1. Funder issues the allowance (cap 0.01 SUI, expires in 7 days).
//    SPIKE_ALLOWANCE_ID reuses an already-issued allowance on reruns.
let allowanceId = process.env.SPIKE_ALLOWANCE_ID;
let issueDigest = "reused";
if (!allowanceId) {
const issue = new Transaction();
issue.setSender(funderAddress);
const noRateLimit = issue.moveCall({
  target: "0x1::option::none",
  typeArguments: ["0x2::allowance::RateLimit"],
});
issue.moveCall({
  target: "0x2::allowance::new",
  typeArguments: ["0x2::balance::Balance<0x2::sui::SUI>"],
  arguments: [
    issue.pure.string("VOTOI spike allowance"),
    issue.pure.address(spenderAddress),
    issue.pure.option("u256", 10_000_000n),
    issue.pure.option("u64", null),
    issue.pure.option("u64", BigInt(Date.now() + 7 * 24 * 3600 * 1000)),
    noRateLimit,
  ],
});
const issued = await execute(issue, funder);
const allowanceChange = issued.objectChanges?.find(
  (c) => c.type === "created" && c.objectType.includes("::allowance::Allowance"),
);
if (!allowanceChange || allowanceChange.type !== "created") {
  throw new Error("allowance object not found in issue effects");
}
allowanceId = allowanceChange.objectId;
issueDigest = issued.digest;
console.log(`allowance issued: ${allowanceId} (tx ${issued.digest})`);
}

// 2. Spender pulls 0.005 SUI from the funder via the allowance -> payee.
const spend = new Transaction();
spend.setSender(spenderAddress);
const balance = spend.balance({
  allowance: { objectId: allowanceId, funder: funderAddress },
  balance: 5_000_000n,
});
const coin = spend.moveCall({
  target: "0x2::coin::from_balance",
  typeArguments: ["0x2::sui::SUI"],
  arguments: [balance],
});
spend.transferObjects([coin], PAYEE);
const spent = await execute(spend, spender);
console.log(`spend executed: ${spent.digest}`);

const funderAfter = (await client.getBalance({ owner: funderAddress })).totalBalance;
console.log(`funder SUI balance after: ${funderAfter}`);

writeFileSync(
  new URL("./spike-allowance-results.json", import.meta.url),
  JSON.stringify(
    {
      funder: funderAddress,
      spender: spenderAddress,
      payee: PAYEE,
      allowanceId,
      issueDigest,
      spendDigest: spent.digest,
      capMist: "10000000",
      spendMist: "5000000",
      funderBalanceAfter: funderAfter,
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("Saved scripts/spike-allowance-results.json");
