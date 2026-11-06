/**
 * Tatum Data API readers with graceful fallbacks.
 *
 * Exchange rate: GET /v4/data/rate/symbol?symbol=SUI&basePair=USD is the
 * documented route (via the Tatum docs MCP), but this project's key
 * answers 401 - no Data API scope - so CoinGecko remains the working
 * fallback. Candidates are tried in order; the first 200 wins, so a
 * scoped key picks Tatum up with no code change.
 *
 * Address screening: GET /v3/security/address/{address} answers
 * {"status":"valid"} for clean Sui addresses (verified live). Any
 * explicit bad signal blocks a payment; anything else degrades to
 * "unknown" and the payment path decides (availability over blocking,
 * with the verdict logged).
 */

const RATE_CANDIDATES = [
  "https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD",
  "https://api.tatum.io/v3/exchange-rate/SUI/USD",
  "https://api.tatum.io/v3/exchange-rate/SUI",
  "https://api.tatum.io/v4/data/rate/SUI/USD",
  "https://api.tatum.io/v4/data/rate/SUI",
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function pickRate(body: unknown): number | null {
  const r = asRecord(body);
  const cands = [
    r["value"],
    r["rate"],
    r["price"],
    r["usd"],
    asRecord(r["data"])["value"],
    asRecord(r["data"])["rate"],
    asRecord(r["data"])["usd"],
  ];
  for (const c of cands) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** SUI/USD from Tatum Data API, or null when unavailable. */
export async function getTatumSuiUsdRate(apiKey?: string): Promise<number | null> {
  const key = apiKey ?? process.env.TATUM_API_KEY;
  if (!key) return null;
  for (const url of RATE_CANDIDATES) {
    try {
      const res = await fetch(url, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const rate = pickRate(await res.json());
      if (rate !== null) return rate;
    } catch {
      // next candidate, then the CoinGecko fallback in suiReads
    }
  }
  return null;
}

export type ScreenVerdict = "safe" | "blocked" | "unknown";

const BAD_SIGNALS = [
  "invalid",
  "malicious",
  "flagged",
  "blocked",
  "risky",
  "fraud",
  "scam",
  "illicit",
  "sanction",
  "phishing",
  "hack",
];

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

export interface ScreenResult {
  verdict: ScreenVerdict;
  detail: string;
}

/** Screen one destination address through Tatum before paying it. */
export async function screenSuiAddress(
  address: string,
  apiKey?: string,
): Promise<ScreenResult> {
  const key = apiKey ?? process.env.TATUM_API_KEY;
  if (!key) return { verdict: "unknown", detail: "no Tatum API key configured" };
  try {
    const res = await fetch(
      `https://api.tatum.io/v3/security/address/${encodeURIComponent(address)}`,
      { headers: { "x-api-key": key }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return { verdict: "unknown", detail: `screening HTTP ${res.status}` };
    const body: unknown = await res.json();
    const strings: string[] = [];
    collectStrings(body, strings);
    // Bad signals first: "invalid" contains "valid".
    const hit = strings.find((s) => BAD_SIGNALS.some((b) => s.includes(b)));
    if (hit) return { verdict: "blocked", detail: `Tatum flagged: ${hit.slice(0, 120)}` };
    if (strings.some((s) => s === "valid" || s.includes("not malicious") || s.includes("clean"))) {
      return { verdict: "safe", detail: "Tatum screening: valid" };
    }
    return { verdict: "unknown", detail: `unrecognized screening shape: ${JSON.stringify(body).slice(0, 120)}` };
  } catch (err) {
    return { verdict: "unknown", detail: `screening unreachable: ${(err as Error).message.slice(0, 100)}` };
  }
}
