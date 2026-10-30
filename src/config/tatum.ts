/**
 * Tatum integration for Sui: RPC gateway, simulation and x402 config.
 *
 * Reality check (verified against the installed @tatumio/tatum v4.2.60
 * type declarations and docs.tatum.io): the JS SDK has NO Sui network,
 * NO Sui client class and NO prepareMultiPartyTransfer function. Sui is
 * reached through Tatum in three ways, all used by this project:
 * 1. Hosted Sui JSON-RPC gateway: https://sui-<network>.gateway.tatum.io
 *    authenticated with the x-api-key header (this file).
 * 2. Tatum webhooks for address monitoring (src/api/webhook.ts).
 *
 * There is also NO Tatum x402 product: no @tatumio/x402 package exists
 * and no public x402 facilitator supports Sui. The x402-style payment
 * flow is therefore built by this project itself in Step 3 on native
 * Sui primitives: Programmable Transaction Blocks plus sponsored
 * transactions (gas owner different from sender, both sign).
 *
 * Transaction building and signing live in the services layer with
 * @mysten/sui; this module is transport and configuration only.
 */

export type SuiNetworkName = "mainnet" | "testnet";

/** RULE.md Rule 3: hard ceiling for one automated agent payment. */
export const AGENT_PAYMENT_CAP_USD = 50;

/** USDC on Sui uses 6 decimals. The coin type address is configured in
 *  the payments service (Step 3), never guessed in config code. */
export const USDC_DECIMALS = 6;

export interface TatumConfig {
  apiKey: string;
  network: SuiNetworkName;
  /** Sui JSON-RPC endpoint on the Tatum gateway. */
  rpcUrl: string;
  /** Base URL of OUR OWN x402-compatible facilitator endpoint
   *  (self-hosted in Step 3). Empty until it is deployed. */
  x402FacilitatorUrl: string;
  /** CAIP-2 style network id used in x402 payment requirements. */
  x402NetworkId: "sui:mainnet" | "sui:testnet";
  webhookSecret: string;
  /** Escrow account that signs automated agent payments. */
  agentAddress: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

let cached: TatumConfig | null = null;

export function getTatumConfig(): TatumConfig {
  if (cached) return cached;
  const network: SuiNetworkName =
    process.env.SUI_NETWORK === "testnet" ? "testnet" : "mainnet";
  cached = {
    apiKey: requireEnv("TATUM_API_KEY"),
    network,
    rpcUrl:
      process.env.TATUM_SUI_RPC_URL ?? `https://sui-${network}.gateway.tatum.io`,
    x402FacilitatorUrl: process.env.VOTOI_X402_FACILITATOR_URL ?? "",
    x402NetworkId: network === "mainnet" ? "sui:mainnet" : "sui:testnet",
    webhookSecret: process.env.TATUM_WEBHOOK_SECRET ?? "",
    agentAddress: process.env.VOTOI_AGENT_SUI_ADDRESS ?? "",
  };
  return cached;
}

// ------------------------------------------------------------ RPC transport

export class TatumRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "TatumRpcError";
  }
}

let rpcId = 0;

/** One Sui JSON-RPC call through the Tatum gateway. */
export async function suiRpc<T>(method: string, params: unknown[]): Promise<T> {
  const { rpcUrl, apiKey } = getTatumConfig();
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new TatumRpcError(`Tatum gateway HTTP ${response.status} for ${method}`);
  }
  const body = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error) {
    throw new TatumRpcError(body.error.message, body.error.code);
  }
  return body.result as T;
}

// ------------------------------------------------------- typed RPC wrappers

export interface SuiGasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

export interface SuiDryRunResult {
  effects: {
    status: { status: "success" | "failure"; error?: string };
    gasUsed: SuiGasUsed;
  };
  balanceChanges?: Array<{ owner: unknown; coinType: string; amount: string }>;
}

/**
 * The "simulator" of SPEC section 3.1: Sui dry-run executed through the
 * Tatum gateway. Projects balance changes and gas before anything is
 * signed, so the agent can check the result against Walrus budget rules.
 */
export function dryRunTransactionBlock(txBytesBase64: string) {
  return suiRpc<SuiDryRunResult>("sui_dryRunTransactionBlock", [txBytesBase64]);
}

export interface SuiExecuteResult {
  digest: string;
  effects?: { status: { status: "success" | "failure"; error?: string } };
}

export function executeTransactionBlock(txBytesBase64: string, signatures: string[]) {
  return suiRpc<SuiExecuteResult>("sui_executeTransactionBlock", [
    txBytesBase64,
    signatures,
    { showEffects: true, showBalanceChanges: true },
    "WaitForLocalExecution",
  ]);
}

export function getBalance(owner: string, coinType?: string) {
  return suiRpc<{ totalBalance: string }>(
    "suix_getBalance",
    coinType ? [owner, coinType] : [owner],
  );
}

// ------------------------------------------------------------- USD helpers

/** USD amount to USDC base units (6 decimals), integer math only. */
export function usdToUsdcUnits(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`Invalid USD amount: ${amountUsd}`);
  }
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}

export function usdcUnitsToUsd(units: bigint | string): number {
  return Number(BigInt(units)) / 10 ** USDC_DECIMALS;
}
