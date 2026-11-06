/**
 * Receipt blob vault: raw receipt/invoice files land in Walrus Blob
 * Storage as immutable fiscal evidence, linked from the ledger row.
 * Uploads run in the background after POST /api/receipts accepts the
 * file; a vault failure never fails the upload, it is recorded honestly
 * on the receipt status instead.
 */

const PUBLISHER_URL =
  process.env.WALRUS_PUBLISHER_URL ?? "https://publisher.walrus-mainnet.walrus.space";

export type VaultResult = { blobId: string } | { error: string };

export function isVaultOk(r: VaultResult): r is { blobId: string } {
  return (r as { blobId?: unknown }).blobId !== undefined;
}

export async function uploadReceiptToVault(
  data: Buffer,
  mimeType: string,
): Promise<VaultResult> {
  try {
    const res = await fetch(`${PUBLISHER_URL}/v1/blobs?epochs=1`, {
      method: "PUT",
      headers: { "content-type": mimeType || "application/octet-stream" },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { error: `vault HTTP ${res.status}` };
    const body = (await res.json()) as {
      newlyCreated?: { blobObject?: { blobId?: string } };
      alreadyCertified?: { blobId?: string };
    };
    const blobId = body.newlyCreated?.blobObject?.blobId ?? body.alreadyCertified?.blobId;
    if (typeof blobId === "string" && blobId.length > 0) return { blobId };
    return { error: `unrecognized vault response: ${JSON.stringify(body).slice(0, 150)}` };
  } catch (err) {
    return { error: `vault unreachable: ${(err as Error).message.slice(0, 120)}` };
  }
}

/** Public read URL for one Walrus blob id. */
export function walrusBlobUrl(blobId: string): string {
  const agg =
    process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-mainnet.walrus.space";
  return `${agg}/v1/blobs/${blobId}`;
}

/** Suiscan links for digests and objects (judge-verifiable proof). */
export function suiscanTxUrl(digest: string): string {
  return `https://suiscan.xyz/mainnet/tx/${digest}`;
}

export function suiscanObjectUrl(objectId: string): string {
  return `https://suiscan.xyz/mainnet/object/${objectId}`;
}
