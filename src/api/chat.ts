import { isValidSuiAddress } from "@mysten/sui/utils";
import { db } from "../db/client";
import { mediaUploads } from "../db/schema";
import { handleChat } from "../services/agent";
import { ensureUser } from "../services/rehydration";

/**
 * POST /api/v1/chat (SPEC 2.1) as a framework-agnostic handler: the
 * server shell (Express in the app scaffold) adapts req/res to this
 * { status, body } shape, which keeps the route testable without a
 * running server.
 *
 * Latency contract (RULE.md Boundary 1): this handler only does cache
 * reads, ledger writes and - for payments - one simulated + executed
 * PTB. Receipt files are NEVER decoded here: a client uploads the file
 * to Walrus Blob Storage first and passes its blob id; the row lands as
 * "queued" and workers/asyncOcr.ts drains it in the background.
 */

export interface ChatRequestBody {
  user_id?: string;
  session_id?: string;
  message?: string;
  file_attachment?: {
    walrus_blob_id?: string;
    mime_type?: string;
    kind?: "receipt" | "invoice";
  };
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

function error(status: number, message: string): HandlerResult {
  return { status, body: { status: "error", response: message } };
}

export async function postChat(body: ChatRequestBody): Promise<HandlerResult> {
  const userId = body.user_id ?? "";
  if (!isValidSuiAddress(userId)) {
    return error(400, "user_id must be a valid Sui wallet address.");
  }
  const message = (body.message ?? "").trim();
  const attachment = body.file_attachment;
  if (!message && !attachment?.walrus_blob_id) {
    return error(400, "message or file_attachment.walrus_blob_id is required.");
  }

  await ensureUser(userId);

  let queuedUploadId: string | null = null;
  if (attachment?.walrus_blob_id) {
    const [row] = await db
      .insert(mediaUploads)
      .values({
        userId,
        walrusBlobId: attachment.walrus_blob_id,
        mimeType: attachment.mime_type ?? "application/octet-stream",
        kind: attachment.kind ?? "receipt",
        ocrStatus: "queued",
      })
      .returning({ uploadId: mediaUploads.uploadId });
    queuedUploadId = row.uploadId;
  }

  if (!message) {
    return {
      status: 202,
      body: {
        status: "success",
        response:
          "Receipt received. I am processing it asynchronously; the expense will appear in your ledger shortly.",
        raw_blob_id: attachment?.walrus_blob_id,
        upload_id: queuedUploadId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  const result = await handleChat({
    userId,
    sessionId: body.session_id ?? "default",
    message,
  });
  return {
    status: 200,
    body: {
      status: "success",
      response: result.response,
      action: result.action,
      ...(result.txDigest ? { tx_digest: result.txDigest } : {}),
      ...(queuedUploadId ? { upload_id: queuedUploadId } : {}),
      timestamp: new Date().toISOString(),
    },
  };
}
