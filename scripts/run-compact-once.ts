// One-off: recover pending Walrus writes, then run a single seed-free
// compaction pass so outstanding facts (GrabFood rev 2, spending profile)
// land on Walrus Memory Mainnet. Safe to rerun: durable pipeline replays
// intents with deterministic sha256 idempotency keys.
process.loadEnvFile(".env");
const { recoverPendingWrites, runCompactDream } = await import(
  "../src/workers/compactDream.ts"
);
console.log("recovery:", JSON.stringify(await recoverPendingWrites()));
console.log("compaction:", JSON.stringify(await runCompactDream()));
