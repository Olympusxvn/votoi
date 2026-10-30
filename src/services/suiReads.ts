import { suiRpc, TatumRpcError } from "../config/tatum";

/**
 * Read-only Sui queries through the Tatum gateway (plain JSON-RPC via
 * config/tatum.suiRpc: cheap single calls, no SDK resolver bursts).
 *
 * Transaction confirmation lives here on purpose: Tatum Notifications
 * does not support Sui (verified 2026-10-21), so payment status is
 * confirmed with sui_getTransactionBlock reads instead of webhooks -
 * point checks on demand, never block polling (RULE.md Guardrail 1).
 */

export const SUI_COIN_TYPE = "0x2::sui::SUI";
const ALLOWANCE_CAP_TYPE = "0x2::allowance::AllowanceCap";

interface SuiObjectContent {
  data?: {
    content?: {
      fields?: Record<string, unknown>;
    };
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

export async function getSuiBalanceMist(owner: string): Promise<bigint> {
  const res = await suiRpc<{ totalBalance: string }>("suix_getBalance", [
    owner,
    SUI_COIN_TYPE,
  ]);
  return BigInt(res.totalBalance);
}

export interface AllowanceState {
  allowanceId: string;
  name: string;
  funder: string;
  spender: string;
  /** Lifetime cap in the coin's smallest units; null means uncapped. */
  lifetimeCapMist: bigint | null;
  currentSpendMist: bigint;
  /** Cap minus already spent; null when uncapped. */
  remainingMist: bigint | null;
  expirationMs: number | null;
}

/** Parse one on-chain Allowance object (fields verified live 2026-10-21:
 *  settings { funder, spender, lifetime_cap, expiration_timestamp_ms,
 *  name } plus current_spend at the top level). */
export async function getAllowanceState(
  allowanceId: string,
): Promise<AllowanceState | null> {
  const res = await suiRpc<SuiObjectContent>("sui_getObject", [
    allowanceId,
    { showContent: true },
  ]);
  const fields = res.data?.content?.fields;
  if (!fields) return null;
  const settings = asRecord(asRecord(fields.settings).fields);
  const cap = toBigIntOrNull(settings.lifetime_cap);
  const spent = toBigIntOrNull(fields.current_spend) ?? 0n;
  const expiration = settings.expiration_timestamp_ms;
  return {
    allowanceId,
    name: String(settings.name ?? ""),
    funder: String(settings.funder ?? ""),
    spender: String(settings.spender ?? ""),
    lifetimeCapMist: cap,
    currentSpendMist: spent,
    remainingMist: cap === null ? null : cap - spent,
    expirationMs:
      expiration === null || expiration === undefined
        ? null
        : Number(expiration),
  };
}

/** Every allowance `funder` issued where `spender` is the named spender,
 *  discovered through the funder's AllowanceCap objects. */
export async function findAllowancesForSpender(
  funder: string,
  spender: string,
): Promise<AllowanceState[]> {
  const page = await suiRpc<{
    data: Array<{ data?: { objectId: string; content?: { fields?: Record<string, unknown> } } }>;
  }>("suix_getOwnedObjects", [
    funder,
    {
      filter: { StructType: ALLOWANCE_CAP_TYPE },
      options: { showContent: true },
    },
    null,
    25,
  ]);
  const states: AllowanceState[] = [];
  for (const entry of page.data ?? []) {
    const allowanceId = entry.data?.content?.fields?.allowance;
    if (typeof allowanceId !== "string") continue;
    const state = await getAllowanceState(allowanceId);
    if (state && state.spender === spender) states.push(state);
  }
  return states;
}

export type TransactionStatus = "success" | "failure" | "not_found";

/** Point-in-time confirmation of one digest (the webhook replacement). */
export async function getTransactionStatus(
  digest: string,
): Promise<TransactionStatus> {
  try {
    const res = await suiRpc<{ effects?: { status?: { status?: string } } }>(
      "sui_getTransactionBlock",
      [digest, { showEffects: true }],
    );
    return res.effects?.status?.status === "success" ? "success" : "failure";
  } catch (err) {
    if (err instanceof TatumRpcError) return "not_found";
    throw err;
  }
}

export interface RecentTransaction {
  digest: string;
  timestampMs: number | null;
}

export async function listRecentTransactions(
  owner: string,
  limit = 10,
): Promise<RecentTransaction[]> {
  const res = await suiRpc<{
    data: Array<{ digest: string; timestampMs?: string }>;
  }>("suix_queryTransactionBlocks", [
    { filter: { FromAddress: owner }, options: {} },
    null,
    limit,
    true,
  ]);
  return (res.data ?? []).map((tx) => ({
    digest: tx.digest,
    timestampMs: tx.timestampMs ? Number(tx.timestampMs) : null,
  }));
}

// ------------------------------------------------------------ SUI/USD rate

let rateCache: { usd: number; at: number } | null = null;

/**
 * SUI price in USD for accounting conversions (all ledger math is USD;
 * settlement is in SUI). SUI_USD_RATE env wins; otherwise CoinGecko's
 * keyless endpoint, cached for 60 seconds. Returns null when no rate is
 * available - callers must refuse to quote or pay rather than guess.
 */
export async function getSuiUsdRate(): Promise<number | null> {
  const fromEnv = Number(process.env.SUI_USD_RATE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (rateCache && Date.now() - rateCache.at < 60_000) return rateCache.usd;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd",
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { sui?: { usd?: number } };
    const usd = body.sui?.usd;
    if (typeof usd !== "number" || usd <= 0) return null;
    rateCache = { usd, at: Date.now() };
    return usd;
  } catch {
    return null;
  }
}

/** USD -> MIST at the given rate, integer math, rounds to nearest MIST. */
export function usdToMist(amountUsd: number, suiUsdRate: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`Invalid USD amount: ${amountUsd}`);
  }
  if (!Number.isFinite(suiUsdRate) || suiUsdRate <= 0) {
    throw new Error(`Invalid SUI/USD rate: ${suiUsdRate}`);
  }
  return BigInt(Math.round((amountUsd / suiUsdRate) * 1_000_000_000));
}

export function mistToUsd(mist: bigint, suiUsdRate: number): number {
  return (Number(mist) / 1_000_000_000) * suiUsdRate;
}
