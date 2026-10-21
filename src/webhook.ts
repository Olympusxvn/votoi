import crypto from 'crypto';

export interface TatumSuiWebhookPayload {
  data?: {
    kind?: string;
    blockHash?: string;
    blockNumber?: number;
    blockTimestamp?: number;
    txId?: string;
    digest?: string;
    currency?: string;
    txTimestamp?: number;
    from?: string;
    to?: string;
    value?: string | number;
    contractAddress?: string;
    tokenId?: string;
    additionalData?: Record<string, unknown>;
    tokenMetadata?: {
      type?: string;
      decimals?: number;
      symbol?: string;
      name?: string;
      uri?: string;
    };
    subscriptionId?: string;
    subscriptionType?: string;
    events?: Array<{
      type?: string;
      parsedJson?: Record<string, unknown>;
      packageId?: string;
      transactionModule?: string;
      sender?: string;
      bcs?: string;
      [key: string]: unknown;
    }>;
    effects?: {
      status?: {
        status?: string;
        error?: string;
      };
      gasUsed?: {
        computationCost?: string;
        storageCost?: string;
        storageRebate?: string;
        nonRefundableStorageFee?: string;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  digest?: string;
  txId?: string;
  transactionHash?: string;
  blockNumber?: number;
  blockHeight?: number;
  checkpoint?: number;
  subscriptionId?: string;
  subscriptionType?: string;
  type?: string;
  timestamp?: number;
  id?: string;
  location?: string;
  scheme?: string;
  events?: Array<unknown>;
  [key: string]: unknown;
}

export interface TatumWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string | Buffer | Uint8Array;
}

export interface TatumWebhookHandlerConfig {
  webhookSecret?: string;
  findTransactionByDigest: (digest: string) => Promise<unknown | null | undefined>;
  markTransactionConfirmed: (
    digest: string,
    blockHeight?: number | null,
    eventData?: unknown
  ) => Promise<void>;
}

export interface WebhookSuccessResponse {
  digest: string;
  confirmed: boolean;
  alreadyProcessed?: boolean;
}

export interface WebhookErrorResponse {
  error: string;
  code: string;
  details?: string;
}

export interface TatumWebhookResponse {
  status: number;
  body: WebhookSuccessResponse | WebhookErrorResponse;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string
): string | undefined {
  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(value)) {
        return value[0];
      }
      return value;
    }
  }
  return undefined;
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const trimmedSig = signatureHeader.trim();
  const hmac = crypto.createHmac('sha512', secret);
  hmac.update(rawBody);
  const expectedBase64 = hmac.digest('base64');

  const hmacHex = crypto.createHmac('sha512', secret);
  hmacHex.update(rawBody);
  const expectedHex = hmacHex.digest('hex');

  const sigBuffer = Buffer.from(trimmedSig);
  const expectedBase64Buffer = Buffer.from(expectedBase64);
  const expectedHexBuffer = Buffer.from(expectedHex);

  if (
    sigBuffer.length === expectedBase64Buffer.length &&
    crypto.timingSafeEqual(sigBuffer, expectedBase64Buffer)
  ) {
    return true;
  }

  if (
    sigBuffer.length === expectedHexBuffer.length &&
    crypto.timingSafeEqual(sigBuffer, expectedHexBuffer)
  ) {
    return true;
  }

  return false;
}

export function extractDigestAndHeight(payload: TatumSuiWebhookPayload): {
  digest: string | null;
  blockHeight: number | null;
  eventData: unknown;
} {
  const digest =
    payload.data?.digest ||
    payload.data?.txId ||
    payload.digest ||
    payload.txId ||
    payload.transactionHash ||
    null;

  let blockHeight: number | null = null;
  if (typeof payload.data?.blockNumber === 'number') {
    blockHeight = payload.data.blockNumber;
  } else if (typeof payload.blockNumber === 'number') {
    blockHeight = payload.blockNumber;
  } else if (typeof payload.blockHeight === 'number') {
    blockHeight = payload.blockHeight;
  } else if (typeof payload.checkpoint === 'number') {
    blockHeight = payload.checkpoint;
  }

  const eventData = payload.data?.events ?? payload.events ?? payload.data ?? payload;

  return { digest, blockHeight, eventData };
}

export async function handleTatumWebhook(
  req: TatumWebhookRequest,
  config: TatumWebhookHandlerConfig
): Promise<TatumWebhookResponse> {
  let rawBodyString: string;
  if (typeof req.rawBody === 'string') {
    rawBodyString = req.rawBody;
  } else if (Buffer.isBuffer(req.rawBody)) {
    rawBodyString = req.rawBody.toString('utf8');
  } else if (req.rawBody instanceof Uint8Array) {
    rawBodyString = Buffer.from(req.rawBody).toString('utf8');
  } else {
    return {
      status: 400,
      body: {
        error: 'Invalid request: raw body must be provided as string or Buffer',
        code: 'INVALID_RAW_BODY',
      },
    };
  }

  const webhookSecret = config.webhookSecret ?? process.env.TATUM_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return {
      status: 401,
      body: {
        error: 'Webhook verification secret is not configured',
        code: 'MISSING_WEBHOOK_SECRET',
      },
    };
  }

  const signatureHeader = getHeader(req.headers, 'x-payload-hash');
  const isValid = verifyWebhookSignature(rawBodyString, signatureHeader, webhookSecret);

  if (!isValid) {
    return {
      status: 401,
      body: {
        error: 'Unauthorized: signature verification failed',
        code: 'INVALID_SIGNATURE',
      },
    };
  }

  let payload: TatumSuiWebhookPayload;
  try {
    const parsed = JSON.parse(rawBodyString);
    if (!parsed || typeof parsed !== 'object') {
      return {
        status: 400,
        body: {
          error: 'Malformed JSON payload: expected a JSON object',
          code: 'MALFORMED_JSON_PAYLOAD',
        },
      };
    }
    payload = parsed as TatumSuiWebhookPayload;
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : 'JSON parse failure';
    return {
      status: 400,
      body: {
        error: 'Malformed JSON payload: unable to parse request body',
        code: 'JSON_PARSE_ERROR',
        details,
      },
    };
  }

  const { digest, blockHeight, eventData } = extractDigestAndHeight(payload);
  if (!digest || typeof digest !== 'string' || digest.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: 'Invalid payload: missing transaction digest or txId',
        code: 'MISSING_TRANSACTION_DIGEST',
      },
    };
  }

  const trimmedDigest = digest.trim();

  try {
    const existingTx = await config.findTransactionByDigest(trimmedDigest);
    if (existingTx) {
      return {
        status: 200,
        body: {
          digest: trimmedDigest,
          confirmed: true,
          alreadyProcessed: true,
        },
      };
    }

    await config.markTransactionConfirmed(trimmedDigest, blockHeight, eventData);

    return {
      status: 200,
      body: {
        digest: trimmedDigest,
        confirmed: true,
      },
    };
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : 'Database operation failed';
    return {
      status: 500,
      body: {
        error: 'Failed to process transaction in storage callback',
        code: 'STORAGE_CALLBACK_ERROR',
        details,
      },
    };
  }
}
