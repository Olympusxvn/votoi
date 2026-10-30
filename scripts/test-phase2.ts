/**
 * Phase 2 live test: rehydration (build -> wipe -> rebuild), chat
 * expense + question via the API handler, then a fresh allowance
 * issued with production code and a chat-driven payment through it.
 * Run from repo root: npx tsx scripts/test-phase2.ts
 */
process.loadEnvFile(".env");

const { rehydrateUser, wipeCache } = await import("../src/services/rehydration.ts");
const { postChat } = await import("../src/api/chat.ts");
const payments = await import("../src/services/agentPayments.ts");
const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const { toBase64 } = await import("@mysten/bcs");

const MAIN = "0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804";
const FUNDER = "0x5dc5f85e4ca400f971f0166cba041bb33a37dadb1d2511b9a87b9150c8b2e1ac";

// 1. Cold rehydration from Walrus.
const first = await rehydrateUser(MAIN);
console.log(`rehydrate #1: source=${first.source} facts=${first.facts.length}`);

// 2. Wipe and rebuild - the demo flow.
const wiped = await wipeCache(MAIN);
const second = await rehydrateUser(MAIN);
console.log(
  `wipe deleted=${wiped.deletedFacts}; rehydrate #2: source=${second.source} facts=${second.facts.length}`,
);

// 3. Chat: log an expense, then ask a question (warm cache path).
const expense = await postChat({
  user_id: MAIN,
  session_id: "phase2-test",
  message: "spent 12.50 at GrabFood",
});
console.log(`chat expense [${expense.status}]: ${String(expense.body.response).slice(0, 160)}`);
const question = await postChat({
  user_id: MAIN,
  session_id: "phase2-test",
  message: "what are my coffee spending habits?",
});
console.log(`chat question [${question.status}]: ${String(question.body.response).slice(0, 220)}`);

// 4. Issue a fresh allowance with the production builder.
const funderKey = Ed25519Keypair.fromSecretKey(process.env.VOTOI_AGENT_SUI_PRIVATE_KEY!);
const spenderAddress = payments.getAgentSpenderAddress();
const client = payments.getTatumSuiClient();
const issueTx = payments.buildIssueAllowanceTx({
  funder: FUNDER,
  spender: spenderAddress,
  name: "VOTOI phase2 allowance",
  lifetimeCapMist: 20_000_000n,
  expirationMs: Date.now() + 30 * 24 * 3600 * 1000,
});
issueTx.setGasBudget(6_000_000n);
issueTx.setGasPrice(BigInt(await client.getReferenceGasPrice()));
const issueBytes = await issueTx.build({ client });
const { signature } = await funderKey.signTransaction(issueBytes);
const issued = await client.executeTransactionBlock({
  transactionBlock: toBase64(issueBytes),
  signature,
  options: { showEffects: true, showObjectChanges: true },
});
await client.waitForTransaction({ digest: issued.digest, options: { showEffects: true } });
const created = issued.objectChanges?.find(
  (c) => c.type === "created" && c.objectType.includes("::allowance::Allowance<"),
);
console.log(`allowance issued via production builder: tx=${issued.digest} obj=${created && created.type === "created" ? created.objectId : "?"}`);

// 5. Chat-driven payment from the funder wallet through the allowance.
const pay = await postChat({
  user_id: FUNDER,
  session_id: "phase2-test",
  message: `pay 0.01 USD to ${MAIN}`,
});
console.log(`chat payment [${pay.status}]: ${String(pay.body.response).slice(0, 220)}`);
