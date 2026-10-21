import {
  SuiClient,
  SuiHTTPTransport,
  type DryRunTransactionBlockResponse,
  type TransactionEffects,
  type BalanceChange,
} from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { toBase64 } from '@mysten/bcs';

export const TATUM_SUI_GATEWAY_URL = 'https://sui-mainnet.gateway.tatum.io';
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
  client?: SuiClient;
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
  client?: SuiClient;
  requestType?: 'WaitForEffectsCert' | 'WaitForLocalExecution';
}

export function getTatumSuiClient(apiKey?: string): SuiClient {
  const key = apiKey ?? process.env.TATUM_API_KEY;
  const headers: Record<string, string> = {};
  if (key) {
    headers['x-api-key'] = key;
  }
  const transport = new SuiHTTPTransport({
    url: TATUM_SUI_GATEWAY_URL,
    rpc: {
      headers,
    },
  });
  return new SuiClient({
    transport,
  });
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
  client?: SuiClient
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
