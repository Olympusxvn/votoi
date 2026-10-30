process.loadEnvFile(".env");
const { rememberFact } = await import("../src/config/walrus.ts");
const FUNDER = "0x5dc5f85e4ca400f971f0166cba041bb33a37dadb1d2511b9a87b9150c8b2e1ac";
try {
  const r = await rememberFact(
    FUNDER,
    "[watchdog:preference] pipeline probe | write path health check, rev 1 | ignore this probe fact",
  );
  console.log("probe write OK, blob:", r.blobId);
} catch (err) {
  console.log("probe write FAILED:", err instanceof Error ? err.message.slice(0, 200) : String(err));
}
