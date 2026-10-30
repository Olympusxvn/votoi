process.loadEnvFile(".env");
const key = process.env.TATUM_API_KEY ?? "";
for (const [method, params] of [["sui_getChainIdentifier", []], ["suix_getBalance", ["0x5dc5f85e4ca400f971f0166cba041bb33a37dadb1d2511b9a87b9150c8b2e1ac"]]] as const) {
  const res = await fetch("https://sui-mainnet.gateway.tatum.io", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  console.log(method, "HTTP", res.status, "=>", (await res.text()).slice(0, 200));
}
const dashPrefix = "t-6a0dc";
const dashSuffix = "5f16e32";
console.log("env key matches dashboard masked key:", key.startsWith(dashPrefix) && key.endsWith(dashSuffix));
