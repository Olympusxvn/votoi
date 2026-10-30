process.loadEnvFile(".env");
const { recallFacts } = await import("../src/config/walrus.ts");
const MAIN = "0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804";
try {
  const r = await recallFacts(MAIN, "coffee spending habits", 3);
  console.log("recall OK, hits:", r.length);
} catch (err) {
  console.log("recall FAILED:", err instanceof Error ? err.message.slice(0, 160) : String(err));
}
