// Generated with Tatum AI Builder (ai.tatum.io) on 2026-10-21 from the project prompt set
// (docs/ai-builder-prompts.md, Prompt 1 v1). Reviewed and integrated into VOTOI.
// Allowance-based spend path (Prompt 1 v2 design) is added separately in this repo.
// 2026-11-06: spend path runs through config/chainTransport (Tatum gRPC first,
// public fallback), so payments survive the Tatum JSON-RPC gateway outage.
import {
  SuiJsonRpcClient,
  type DryRunTransactionBlockResponse,
  type TransactionEffects,
  type BalanceChange,
} from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { toBase64 } from '@mysten/bcs';
import {
  chainOpsForLegacy,
  getChainOps,
  getLegacyTatumClient as getTatumSuiClient,
  graphqlTxStatus,
  type ChainOps,
  type ChainTransportName,
} from "../config/chainTransport";

export { getTatumSuiClient };
export const SPLIT_PAYMENT_USD_CAP = 50.0;

export class HumanApprovalRequired extends Error {
  readonly totalUsd: number;
  readonly cap: number;

  constructor(totalUsd: number, cap: number = SPLIT_PAYMENT_USD_CAP) {
    super(
      `Human approval required: total split payment of $${totalUsd.toFixed(
        2
      )} exceeds the allowed cap of $${cap.toFixed(2)}.`
    );
    this.name = 'HumanApprovalRequired';
    this.totalUsd = totalUsd;
    this.cap = cap;
    Object.setPrototypeOf(this, HumanApprovalRequired.prototype);
  }
}

export class InvalidSuiAddressError extends Error {
  readonly address: string;
  readonly field: string;

  constructor(address: string, field: string) {
    super(`Invalid Sui address provided for ${field}: "${address}".`);
    this.name = 'InvalidSuiAddressError';
    this.address = address;
    this.field = field;
    Object.setPrototypeOf(this, InvalidSuiAddressError.prototype);
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('TATUM_API_KEY environment variable is not set.');
    this.name = 'MissingApiKeyError';
    Object.setPrototypeOf(this, MissingApiKeyError.prototype);
  }
}

export class MissingGasOwnerAddressError extends Error {
  constructor() {
    super('VOTOI_AGENT_SUI_ADDRESS environment variable is not set.');
    this.name = 'MissingGasOwnerAddressError';
    Object.setPrototypeOf(this, MissingGasOwnerAddressError.prototype);
  }
}

export class InvalidCoinObjectIdError extends Error {
  readonly coinObjectId: string;

  constructor(coinObjectId: string) {
    super(`Invalid coin object ID: "${coinObjectId}".`);
    this.name = 'InvalidCoinObjectIdError';
    this.coinObjectId = coinObjectId;
    Object.setPrototypeOf(this, InvalidCoinObjectIdError.prototype);
  }
}

export class InvalidSplitPaymentParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSplitPaymentParamsError';
    Object.setPrototypeOf(this, InvalidSplitPaymentParamsError.prototype);
  }
}

export interface SplitItem {
  recipient: string;
  amountUsd: number;
}

export interface BuildSplitPaymentParams {
  payerAddress: string;
  coinObjectId: string;
  splits: Array<SplitItem>;
  usdToCoinRate: number;
}

export interface GasEstimate {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  nonRefundableStorageFee: string;
  totalNetGasCost: string;
}

export interface DryRunSplitPaymentResult {
  effects: TransactionEffects;
  gasEstimate: GasEstimate;
  balanceChanges: BalanceChange[];
  raw: DryRunTransactionBlockResponse;
}

export interface BuildSponsoredSplitPaymentOptions {
  client?: SuiJsonRpcClient;
  gasBudget?: bigint | number;
  gasPrice?: bigint | number;
  gasPayment?: Array<{
    objectId: string;
    version: number | string;
    digest: string;
  }>;
}

export interface BuildSponsoredSplitPaymentResult {
  kindBytes: Uint8Array;
  txBytes: Uint8Array;
  transaction: Transaction;
  sender: string;
  gasOwner: string;
}

export interface ExecuteSplitPaymentOptions {
  client?: SuiJsonRpcClient;
  requestType?: 'WaitForEffectsCert' | 'WaitForLocalExecution';
}

function validateAddress(address: string, field: string): void {
  if (typeof address !== 'string' || !isValidSuiAddress(address)) {
    throw new InvalidSuiAddressError(address, field);
  }
}

export function convertUsdToCoinUnits(amountUsd: number, usdToCoinRate: number): bigint {
  if (amountUsd <= 0) {
    throw new InvalidSplitPaymentParamsError(`amountUsd must be positive, got ${amountUsd}.`);
  }
  if (usdToCoinRate <= 0) {
    throw new InvalidSplitPaymentParamsError(
      `usdToCoinRate must be positive, got ${usdToCoinRate}.`
    );
  }
  const coinUnits = Math.round(amountUsd * usdToCoinRate);
  if (coinUnits <= 0) {
    throw new InvalidSplitPaymentParamsError(
      `Converted coin amount resulted in 0 smallest units for amountUsd ${amountUsd} at rate ${usdToCoinRate}.`
    );
  }
  return BigInt(coinUnits);
}

export async function buildSplitPayment(params: BuildSplitPaymentParams): Promise<Transaction> {
  const { payerAddress, coinObjectId, splits, usdToCoinRate } = params;

  validateAddress(payerAddress, 'payerAddress');

  if (typeof coinObjectId !== 'string' || coinObjectId.trim().length === 0) {
    throw new InvalidCoinObjectIdError(coinObjectId);
  }

  if (!Array.isArray(splits) || splits.length === 0) {
    throw new InvalidSplitPaymentParamsError('splits must be a non-empty array.');
  }

  if (typeof usdToCoinRate !== 'number' || !Number.isFinite(usdToCoinRate) || usdToCoinRate <= 0) {
    throw new InvalidSplitPaymentParamsError(
      `usdToCoinRate must be a positive number, got ${usdToCoinRate}.`
    );
  }

  let totalUsd = 0;
  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    if (typeof split.amountUsd !== 'number' || !Number.isFinite(split.amountUsd) || split.amountUsd <= 0) {
      throw new InvalidSplitPaymentParamsError(
        `splits[${i}].amountUsd must be a positive number, got ${split.amountUsd}.`
      );
    }
    validateAddress(split.recipient, `splits[${i}].recipient`);
    totalUsd += split.amountUsd;
  }

  const roundedTotal = Math.round((totalUsd + Number.EPSILON) * 100) / 100;
  if (roundedTotal > SPLIT_PAYMENT_USD_CAP) {
    throw new HumanApprovalRequired(roundedTotal, SPLIT_PAYMENT_USD_CAP);
  }

  const tx = new Transaction();
  tx.setSender(payerAddress);

  const coinInput = tx.object(coinObjectId);
  const amounts = splits.map((s) => convertUsdToCoinUnits(s.amountUsd, usdToCoinRate));
  const splitResults = tx.splitCoins(coinInput, amounts);

  for (let i = 0; i < splits.length; i++) {
    tx.transferObjects([splitResults[i]], splits[i].recipient);
  }

  return tx;
}

export async function dryRunSplitPayment(
  tx: Transaction | Uint8Array | string,
  client?: SuiJsonRpcClient
): Promise<DryRunSplitPaymentResult> {
  const suiClient = client ?? getTatumSuiClient();

  let txBytesBase64: string;
  if (typeof tx === 'string') {
    txBytesBase64 = tx;
  } else if (tx instanceof Uint8Array) {
    txBytesBase64 = toBase64(tx);
  } else {
    const bytes = await tx.build({ client: suiClient });
    txBytesBase64 = toBase64(bytes);
  }

  const raw = await suiClient.dryRunTransactionBlock({
    transactionBlock: txBytesBase64,
  });

  const { gasUsed } = raw.effects;
  const computationCost = BigInt(gasUsed.computationCost);
  const storageCost = BigInt(gasUsed.storageCost);
  const storageRebate = BigInt(gasUsed.storageRebate);
  const nonRefundableStorageFee = gasUsed.nonRefundableStorageFee ?? '0';

  const totalNet = computationCost + storageCost - storageRebate;
  const totalNetGasCost = (totalNet > 0n ? totalNet : 0n).toString();

  const gasEstimate: GasEstimate = {
    computationCost: gasUsed.computationCost,
    storageCost: gasUsed.storageCost,
    storageRebate: gasUsed.storageRebate,
    nonRefundableStorageFee,
    totalNetGasCost,
  };

  return {
    effects: raw.effects,
    gasEstimate,
    balanceChanges: raw.balanceChanges ?? [],
    raw,
  };
}

export async function buildSponsoredSplitPayment(
  params: BuildSplitPaymentParams,
  options?: BuildSponsoredSplitPaymentOptions
): Promise<BuildSponsoredSplitPaymentResult> {
  const gasOwnerAddress = process.env.VOTOI_AGENT_SUI_ADDRESS;
  if (!gasOwnerAddress) {
    throw new MissingGasOwnerAddressError();
  }
  validateAddress(gasOwnerAddress, 'process.env.VOTOI_AGENT_SUI_ADDRESS');

  const baseTx = await buildSplitPayment(params);
  const suiClient = options?.client ?? getTatumSuiClient();

  const kindBytes = await baseTx.build({
    client: suiClient,
    onlyTransactionKind: true,
  });

  const sponsoredTx = Transaction.fromKind(kindBytes);
  sponsoredTx.setSender(params.payerAddress);
  sponsoredTx.setGasOwner(gasOwnerAddress);

  if (options?.gasBudget !== undefined) {
    sponsoredTx.setGasBudget(options.gasBudget);
  }
  if (options?.gasPrice !== undefined) {
    sponsoredTx.setGasPrice(options.gasPrice);
  }
  if (options?.gasPayment !== undefined) {
    sponsoredTx.setGasPayment(options.gasPayment);
  }

  const txBytes = await sponsoredTx.build({
    client: suiClient,
  });

  return {
    kindBytes,
    txBytes,
    transaction: sponsoredTx,
    sender: params.payerAddress,
    gasOwner: gasOwnerAddress,
  };
}

export async function executeSplitPayment(
  txBytes: Uint8Array | string,
  signatures: string | string[],
  options?: ExecuteSplitPaymentOptions
): Promise<string> {
  const sigArray = Array.isArray(signatures) ? signatures : [signatures];
  if (sigArray.length === 0) {
    throw new InvalidSplitPaymentParamsError('At least one signature is required.');
  }

  const suiClient = options?.client ?? getTatumSuiClient();
  const txBytesFormatted = typeof txBytes === 'string' ? txBytes : toBase64(txBytes);

  const response = await suiClient.executeTransactionBlock({
    transactionBlock: txBytesFormatted,
    signature: sigArray,
    requestType: options?.requestType,
  });

  return response.digest;
}

// ------------------------------------------------------- allowance payments
//
// The production agent-payment path (Prompt 1 v2 design, proven live on
// Mainnet in scripts/spike-allowance.ts): the user (funder) issues a
// native Sui allowance (0x2::allowance) naming the agent as spender,
// with on-chain lifetime/rate limits in the coin. The agent pulls funds
// straight from the funder's balance via tx.balance({ allowance }) - no
// escrow contract, no sponsored gas. The funder can revoke at any time
// with their AllowanceCap. Sui documents allowances as the mechanism
// agentic wallets use to settle x402 / MPP style payments on Sui.
//
// The USD cap (RULE.md Rule 3) is enforced here in code before anything
// is built, again on-chain by the allowance's own limits, and a third
// time by the agent_payments DB CHECK.

export const SUI_COIN_TYPE = '0x2::sui::SUI';
const BALANCE_SUI_TYPE = '0x2::balance::Balance<0x2::sui::SUI>';

/**
 * The spender identity for this deployment: the MemWal delegate keypair
 * doubles as the allowance spender (the same key that signs memory
 * writes is the one users name in their allowances). Key material comes
 * from .env only and never touches Postgres (RULE.md Rule 2).
 */
export function getAgentSpenderKeypair(): Ed25519Keypair {
  const hex = process.env.MEMWAL_PRIVATE_KEY;
  if (!hex) {
    throw new Error('MEMWAL_PRIVATE_KEY is not set.');
  }
  return Ed25519Keypair.fromSecretKey(Buffer.from(hex, 'hex'));
}

export function getAgentSpenderAddress(): string {
  return getAgentSpenderKeypair().toSuiAddress();
}

/** Building a PTB fires several resolver RPCs at once; a failed build is
 *  read-only, so retry it with backoff. Sending is never retried blindly:
 *  execution happens exactly once. */
async function buildWithRetry(
  ops: ChainOps,
  tx: Transaction
): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await ops.buildTx(tx);
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastErr;
}

export interface IssueAllowanceParams {
  funder: string;
  spender: string;
  name: string;
  /** Lifetime spend cap in MIST; null = no lifetime cap. At least one of
   *  lifetimeCapMist / startMs / expirationMs / a rate limit must be
   *  set - the chain rejects a limit-free Direct allowance. (Parameter
   *  order verified live via sui_getNormalizedMoveFunction: name,
   *  spender, Option<u256> lifetime cap, Option<u64> start,
   *  Option<u64> expiration, Option<RateLimit>.) */
  lifetimeCapMist?: bigint | null;
  startMs?: number | null;
  expirationMs?: number | null;
}

/** Unsigned issuance transaction; the funder signs it (wallet in the
 *  real product, the demo signer in scripts). */
export function buildIssueAllowanceTx(params: IssueAllowanceParams): Transaction {
  validateAddress(params.funder, 'funder');
  validateAddress(params.spender, 'spender');
  const tx = new Transaction();
  tx.setSender(params.funder);
  const noRateLimit = tx.moveCall({
    target: '0x1::option::none',
    typeArguments: ['0x2::allowance::RateLimit'],
  });
  tx.moveCall({
    target: '0x2::allowance::new',
    typeArguments: [BALANCE_SUI_TYPE],
    arguments: [
      tx.pure.string(params.name),
      tx.pure.address(params.spender),
      tx.pure.option('u256', params.lifetimeCapMist ?? null),
      tx.pure.option('u64', params.startMs ?? null),
      tx.pure.option('u64', params.expirationMs ?? null),
      noRateLimit,
    ],
  });
  return tx;
}

export interface RevokeAllowanceParams {
  funder: string;
  capId: string;
  allowanceId: string;
}

/**
 * Unsigned revocation PTB; the funder signs it with their own wallet.
 * Entry verified live 2026-11-06: 0x2::allowance::revoke(cap, allowance).
 */
export function buildRevokeTx(params: RevokeAllowanceParams): Transaction {
  validateAddress(params.funder, 'funder');
  validateAddress(params.capId, 'capId');
  validateAddress(params.allowanceId, 'allowanceId');
  const tx = new Transaction();
  tx.setSender(params.funder);
  tx.moveCall({
    target: '0x2::allowance::revoke',
    typeArguments: [BALANCE_SUI_TYPE],
    arguments: [tx.object(params.capId), tx.object(params.allowanceId)],
  });
  return tx;
}

export interface AllowanceRecipient {
  address: string;
  amountMist: bigint;
}

export interface SpendFromAllowanceParams {
  allowanceId: string;
  funder: string;
  recipients: AllowanceRecipient[];
  /** Total in USD, for the RULE.md Rule 3 cap check and the ledger. */
  totalUsd: number;
  spenderKeypair?: Ed25519Keypair;
  client?: SuiJsonRpcClient;
  gasBudgetMist?: bigint;
}

export interface SpendFromAllowanceResult {
  digest: string;
  totalMist: bigint;
  gasMist: bigint;
  transport: ChainTransportName;
}

/**
 * Pull `recipients` amounts from the funder's balance through their
 * allowance and fan out in one atomic PTB, signed and gas-paid by the
 * spender. Flow: USD cap check -> build -> dry-run simulation gate
 * (SPEC FR-04) -> execute once -> confirm via effects, plus an
 * independent GraphQL cross-check. The whole spend stays on one
 * transport (Tatum gRPC first, public fallback).
 */
export async function spendFromAllowance(
  params: SpendFromAllowanceParams
): Promise<SpendFromAllowanceResult> {
  const roundedTotalUsd = Math.round((params.totalUsd + Number.EPSILON) * 100) / 100;
  if (roundedTotalUsd > SPLIT_PAYMENT_USD_CAP) {
    throw new HumanApprovalRequired(roundedTotalUsd, SPLIT_PAYMENT_USD_CAP);
  }
  if (!params.recipients.length) {
    throw new InvalidSplitPaymentParamsError('recipients must be a non-empty array.');
  }
  validateAddress(params.funder, 'funder');
  let totalMist = 0n;
  for (const [i, r] of params.recipients.entries()) {
    validateAddress(r.address, `recipients[${i}].address`);
    if (r.amountMist <= 0n) {
      throw new InvalidSplitPaymentParamsError(
        `recipients[${i}].amountMist must be positive.`
      );
    }
    totalMist += r.amountMist;
  }

  const spender = params.spenderKeypair ?? getAgentSpenderKeypair();
  const ops = params.client ? chainOpsForLegacy(params.client) : await getChainOps();

  const tx = new Transaction();
  tx.setSender(spender.toSuiAddress());
  const balance = tx.balance({
    allowance: { objectId: params.allowanceId, funder: params.funder },
    balance: totalMist,
  });
  const coin = tx.moveCall({
    target: '0x2::coin::from_balance',
    typeArguments: [SUI_COIN_TYPE],
    arguments: [balance],
  });
  if (params.recipients.length === 1) {
    tx.transferObjects([coin], params.recipients[0].address);
  } else {
    const parts = tx.splitCoins(
      coin,
      params.recipients.map((r) => r.amountMist)
    );
    params.recipients.forEach((r, i) => tx.transferObjects([parts[i]], r.address));
    // The source coin keeps a zero remainder; move it along or PTB validation fails.
    tx.transferObjects([coin], params.recipients[0].address);
  }
  tx.setGasBudget(params.gasBudgetMist ?? 6_000_000n);
  tx.setGasPrice(await ops.getGasPrice());

  const bytes = await buildWithRetry(ops, tx);

  // Simulation gate: a failed dry-run aborts before anything is signed.
  const sim = await ops.simulateTx(bytes);
  if (!sim.ok) {
    throw new Error(
      `Allowance spend simulation failed: ${sim.error ?? 'unknown error'}`
    );
  }

  const { signature } = await spender.signTransaction(bytes);
  const exec = await ops.executeTx(bytes, signature);
  if (!exec.digest) {
    throw new Error(
      'Allowance spend executed but no digest was returned; check the spender wallet before retrying.'
    );
  }
  const conf = await ops.confirmTx(exec.digest);
  const cross = await graphqlTxStatus(exec.digest);
  if (cross === 'failure') {
    throw new Error(`Allowance spend ${exec.digest} reported failure on cross-check`);
  }
  return { digest: exec.digest, totalMist, gasMist: conf.gasMist, transport: ops.transport };
}
