import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { mediaUploads, transactions } from "../db/schema";

/**
 * Async receipt pipeline (RULE.md Boundary 1): the chat route only ever
 * inserts a "queued" media_uploads row and returns; this worker drains
 * the queue away from the conversation thread.
 *
 * Extraction is pluggable: a vision/OCR provider fills raw_text on the
 * upload row (or a future provider call lands here); this worker owns
 * everything after text exists - parsing the receipt into a ledger
 * transaction and flipping the status machine queued -> processing ->
 * done/failed so the UI can poll the row, never the worker.
 */

export interface ReceiptData {
  merchantName: string;
  amountUsd: number;
}

/** Best-effort receipt text parser: the merchant is the first real
 *  line; the amount is the TOTAL line when present, else the largest
 *  dollar amount on the page. Returns null when no amount is legible. */
export function parseReceiptText(text: string): ReceiptData | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const totalMatch = /(?:total|amount due|grand total|balance due)\D*\$?(\d+\.\d{2})/i.exec(
    text,
  );
  let amount: number | null = totalMatch ? Number(totalMatch[1]) : null;
  if (amount === null) {
    const amounts = [...text.matchAll(/\$(\d+\.\d{2})/g)].map((m) => Number(m[1]));
    if (amounts.length > 0) amount = Math.max(...amounts);
  }
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;

  const merchantName = lines[0].slice(0, 80);
  return { merchantName, amountUsd: amount };
}

export interface ProcessSummary {
  processed: number;
  done: number;
  failed: number;
}

/** Drain up to `limit` queued uploads once. Safe to call on a timer;
 *  rows are claimed by flipping them to "processing" first. */
export async function processQueuedUploads(limit = 5): Promise<ProcessSummary> {
  const queued = await db
    .select()
    .from(mediaUploads)
    .where(eq(mediaUploads.ocrStatus, "queued"))
    .limit(limit);

  let done = 0;
  let failed = 0;
  for (const upload of queued) {
    await db
      .update(mediaUploads)
      .set({ ocrStatus: "processing" })
      .where(eq(mediaUploads.uploadId, upload.uploadId));

    const fail = async (error: string) => {
      failed++;
      await db
        .update(mediaUploads)
        .set({ ocrStatus: "failed", error, processedAt: new Date() })
        .where(eq(mediaUploads.uploadId, upload.uploadId));
    };

    if (!upload.rawText) {
      await fail("No OCR text on the upload yet (vision provider has not filled raw_text).");
      continue;
    }
    const parsed = parseReceiptText(upload.rawText);
    if (!parsed) {
      await fail("Could not read a total amount from the receipt text.");
      continue;
    }
    const [tx] = await db
      .insert(transactions)
      .values({
        userId: upload.userId,
        merchantName: parsed.merchantName,
        amountUsd: parsed.amountUsd.toFixed(2),
        source: "receipt_ocr",
        walrusBlobId: upload.walrusBlobId,
      })
      .returning({ txId: transactions.txId });
    await db
      .update(mediaUploads)
      .set({ ocrStatus: "done", transactionId: tx.txId, processedAt: new Date() })
      .where(
        and(
          eq(mediaUploads.uploadId, upload.uploadId),
          eq(mediaUploads.ocrStatus, "processing"),
        ),
      );
    done++;
  }
  return { processed: queued.length, done, failed };
}
