// VOTOI demo server: serves the Builder-generated React frontend (app/)
// and wires its /api/* routes to the real services - Neon cache, Walrus
// Memory Mainnet, and the active Sui chain transport (Tatum gRPC first,
// public fallback). This replaces the Builder preview's mock routes
// (fake blob ids, fake digests, in-memory seeds): every value returned
// here comes from the database or the chain.
// Run: npx tsx src/server.ts  (PORT env, default 3000)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSuiAddress } from "@mysten/sui/utils";
import { Transaction } from "@mysten/sui/transactions";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { createServer as createViteServer } from "vite";
import { postChat } from "./api/chat.js";
import { postWipeCache } from "./api/test/wipe-cache.js";
import {
  getChainOps,
  listCapsByOwner,
  probeTransports,
} from "./config/chainTransport.js";
import { recallFacts, userNamespace, walrusConfig, parseWatchdogFact } from "./config/walrus.js";
import { db } from "./db/client.js";
import {
  agentPayments,
  learnedFacts,
  mediaUploads,
  scheduledBills,
  syncState,
  transactions,
} from "./db/schema";
import {
  buildIssueAllowanceTx,
  buildRevokeTx,
  getAgentSpenderAddress,
} from "./services/agentPayments.js";
import {
  extractRevision,
  ensureUser,
  getCachedFacts,
  rehydrateUser,
} from "./services/rehydration.js";
import {
  findAllowancesForSpender,
  getSuiBalanceMist,
  getSuiUsdRate,
  getTransactionStatus,
  mistToUsd,
  usdToMist,
} from "./services/suiReads.js";
import { screenSuiAddress } from "./services/tatumData.js";
import { recordPaymentMemory } from "./services/paymentMemory.js";
import { createBill, runBillPayPass, type BillRunResult } from "./services/billPay.js";
import { runCompactDream } from "./workers/compactDream.js";
import { processQueuedUploads } from "./workers/asyncOcr.js";
import {
  isVaultOk,
  uploadReceiptToVault,
} from "./services/receiptVault.js";
import { and, desc, eq } from "drizzle-orm";

process.loadEnvFile(".env");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, "..", "app");
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

function badUserId(res: Response, userId: unknown): boolean {
  if (typeof userId !== "string" || !isValidSuiAddress(userId)) {
    res.status(400).json({ error: "userId must be a valid Sui wallet address." });
    return true;
  }
  return false;
}

async function relayerHealth(): Promise<"healthy" | "degraded"> {
  try {
    const base = walrusConfig.serverUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "degraded";
    const body = (await res.json()) as { status?: string; write_ready?: boolean };
    return body.status === "ok" && body.write_ready !== false
      ? "healthy"
      : "degraded";
  } catch {
    return "degraded";
  }
}

// GET /api/health -> judge-verifiable numbers, no Tatum spend.
// Counts come from the local cache and are labeled as such; the relayer
// check is a plain /health fetch. Transport status is last-known only:
// this endpoint deliberately never probes (see probeTransports).
app.get("/api/health", async (_req: Request, res: Response) => {
  let factsCached: number | null = null;
  let walrusBlobsCached: number | null = null;
  let dbStatus: "ok" | "unavailable" = "ok";
  try {
    const rows = await db
      .select({ blobId: learnedFacts.walrusBlobId })
      .from(learnedFacts);
    factsCached = rows.length;
    walrusBlobsCached = new Set(
      rows
        .map((r) => r.blobId)
        .filter((b): b is string => typeof b === "string" && b.length > 0),
    ).size;
  } catch {
    dbStatus = "unavailable";
  }
  res.json({
    ok: dbStatus === "ok",
    factsCached,
    walrusBlobsCached,
    dbStatus,
    relayerStatus: await relayerHealth(),
    chainTransport: await probeTransports({ allowProbe: false }),
    memwalAccountId: walrusConfig.accountId || null,
    tatumGateway: {
      status: "degraded-known",
      note: "Tatum JSON-RPC gateway returns HTTP 404 for Sui methods with this project's key (re-verified 2026-11-06); the Tatum native gRPC gateway is the primary chain transport, public Sui gRPC is the fallback.",
    },
  });
});

// GET /api/status?userId=... -> allowance card + agent balance + relayer health
app.get("/api/status", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (badUserId(res, userId)) return;
  let chainUnavailable = false;
  let allowanceId = "";
  let lifetimeCapUsd: number | null = null;
  let expirationMs: number | null = null;
  let agentBalanceUsd: number | null = null;
  try {
    const spender = getAgentSpenderAddress();
    const agentWallet = process.env.VOTOI_AGENT_SUI_ADDRESS ?? "";
    let allowances = await findAllowancesForSpender(userId, spender);
    if (allowances.length === 0 && agentWallet) {
      // Demo setup: the working allowance is funded by the agent wallet
      // itself; show it when the user has not issued one of their own.
      allowances = await findAllowancesForSpender(agentWallet, spender);
    }
    const rate = await getSuiUsdRate();
    const first = allowances[0];
    if (rate !== null) {
      lifetimeCapUsd =
        first?.lifetimeCapMist === null || first?.lifetimeCapMist === undefined
          ? null
          : mistToUsd(first.lifetimeCapMist, rate);
      agentBalanceUsd = agentWallet
        ? mistToUsd(await getSuiBalanceMist(agentWallet), rate)
        : null;
    }
    allowanceId = first?.allowanceId ?? "";
    expirationMs = first?.expirationMs ?? null;
  } catch {
    chainUnavailable = true;
  }
  let dream: {
    lastMutationAt: string | null;
    lastRehydratedAt: string | null;
    walrusFactCount: number | null;
  } = { lastMutationAt: null, lastRehydratedAt: null, walrusFactCount: null };
  try {
    const [s] = await db.select().from(syncState).where(eq(syncState.userId, userId));
    if (s) {
      dream = {
        lastMutationAt: s.lastMutationAt ? s.lastMutationAt.toISOString() : null,
        lastRehydratedAt: s.lastRehydratedAt ? s.lastRehydratedAt.toISOString() : null,
        walrusFactCount: s.walrusFactCount,
      };
    }
  } catch {
    // dream stays null; the panel shows "never"
  }
  try {
    // Spent total from the local ledger is always real, chain or not.
    const settled = await db
      .select()
      .from(agentPayments)
      .where(
        and(
          eq(agentPayments.userId, userId),
          eq(agentPayments.status, "settled"),
        ),
      );
    const spentUsd = settled.reduce((sum, r) => sum + Number(r.totalUsd), 0);
    res.json({
      allowanceId,
      lifetimeCapUsd,
      spentUsd,
      expirationMs,
      agentBalanceUsd,
      relayerStatus: await relayerHealth(),
      chainReadsUnavailable: chainUnavailable,
      chainTransport: await probeTransports(),
      dream,
      memwalAccountId: walrusConfig.accountId || null,
      namespace: userNamespace(userId),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "status failed" });
  }
});

// GET /api/facts?userId=... -> learned facts parsed from serialized strings
app.get("/api/facts", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (badUserId(res, userId)) return;
  try {
    let rows = await getCachedFacts(userId);
    if (rows.length === 0) {
      const rehydrated = await rehydrateUser(userId);
      rows = rehydrated.facts;
    }
    const facts = rows
      .map((row) => {
        const parsed = parseWatchdogFact(row.factPayload.serializedString);
        if (!parsed) return null;
        return {
          factType: parsed.factType,
          subject: parsed.subject,
          pattern: parsed.pattern,
          rule: parsed.rule,
          revision: extractRevision(parsed.pattern),
          walrusBlobId: row.walrusBlobId ?? "",
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);
    res.json(facts);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "facts failed" });
  }
});

// GET /api/facts/history?userId&factType&subject -> every Walrus revision of
// one slot, oldest first. Memory is append-only, so this is the belief's
// evolution, not just its current state.
app.get("/api/facts/history", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  const factType = req.query.factType as string;
  const subject = req.query.subject as string;
  if (badUserId(res, userId)) return;
  if (typeof factType !== "string" || typeof subject !== "string" || !factType || !subject) {
    res.status(400).json({ error: "factType and subject are required." });
    return;
  }
  try {
    const memories = await recallFacts(userId, `${factType} ${subject}`, 25);
    const out: Array<{ revision: number; serialized: string; blobId: string | null }> = [];
    for (const memory of memories) {
      const raw = memory as unknown as Record<string, unknown>;
      const text = typeof raw.text === "string" ? raw.text : null;
      if (!text) continue;
      const fact = parseWatchdogFact(text);
      if (!fact || fact.factType !== factType || fact.subject.toLowerCase() !== subject.toLowerCase()) {
        continue;
      }
      const blobId =
        typeof raw.blob_id === "string"
          ? raw.blob_id
          : typeof raw.blobId === "string"
            ? raw.blobId
            : null;
      out.push({ revision: extractRevision(fact.pattern), serialized: fact.serialized, blobId });
    }
    out.sort((a, b) => a.revision - b.revision);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "history failed" });
  }
});

// GET /api/payments?userId=... -> agent payment ledger
app.get("/api/payments", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (badUserId(res, userId)) return;
  try {
    const rows = await db
      .select()
      .from(agentPayments)
      .where(eq(agentPayments.userId, userId))
      .orderBy(desc(agentPayments.createdAt))
      .limit(50);
    res.json(
      rows.map((r) => ({
        paymentId: r.paymentId,
        recipient: (r.recipients[0]?.address ?? "") as string,
        recipients: r.recipients,
        amountUsd: Number(r.totalUsd),
        standard: r.standard,
        status: r.status,
        digest: r.txHash ?? "",
        transport: r.transport ?? "tatum",
        failureReason: r.failureReason ?? "",
        timestamp: (r.settledAt ?? r.createdAt).getTime(),
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "payments failed" });
  }
});

// POST /api/chat { userId, message } -> real agent (cache reads + ledger).
// The action is part of the contract: the chat UI renders
// payment_needs_approval as an amber "not sent onchain" card instead of
// treating every reply as plain text.
app.post("/api/chat", async (req: Request, res: Response) => {
  const { userId, message } = req.body as { userId?: string; message?: string };
  try {
    const result = await postChat({ user_id: userId, message });
    res.status(result.status).json({
      reply: result.body.response,
      action: result.body.action,
      ...(result.body.citations
        ? { citations: result.body.citations }
        : {}),
      ...(result.body.tx_digest
        ? { txDigest: result.body.tx_digest }
        : {}),
    });
  } catch (err) {
    res.status(500).json({ reply: err instanceof Error ? err.message : "chat failed" });
  }
});

// POST /api/test/wipe-cache { userId } -> wipe + rehydrate immediately
app.post("/api/test/wipe-cache", async (req: Request, res: Response) => {
  const { userId } = req.body as { userId?: string };
  const wiped = await postWipeCache({ user_id: userId });
  if (wiped.status !== 200 || typeof userId !== "string") {
    res.status(wiped.status).json(wiped.body);
    return;
  }
  const rehydrated = await rehydrateUser(userId);
  res.json({
    wiped: true,
    factsRestored: rehydrated.facts.length,
    degraded: rehydrated.degraded ?? false,
  });
});

// POST /api/allowance/build { userId, lifetimeCapUsd, expirationDays }
// -> UNSIGNED issuance tx for the funder to sign with their own wallet.
app.post("/api/allowance/build", async (req: Request, res: Response) => {
  const { userId, lifetimeCapUsd, expirationDays } = req.body as {
    userId?: string;
    lifetimeCapUsd?: number;
    expirationDays?: number;
  };
  if (badUserId(res, userId)) return;
  const cap = Number(lifetimeCapUsd);
  const days = Number(expirationDays);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(days) || days <= 0) {
    res.status(400).json({ error: "lifetimeCapUsd and expirationDays must be positive." });
    return;
  }
  try {
    const rate = await getSuiUsdRate();
    if (rate === null) {
      res.status(503).json({ error: "SUI/USD rate unavailable; try again." });
      return;
    }
    const tx = buildIssueAllowanceTx({
      funder: userId as string,
      spender: getAgentSpenderAddress(),
      name: "VOTOI",
      lifetimeCapMist: usdToMist(cap, rate),
      expirationMs: Date.now() + days * 24 * 3600 * 1000,
    });
    res.json({
      unsignedTxBytes: Buffer.from(await tx.toJSON()).toString("base64"),
      note: "Unsigned allowance transaction built with buildIssueAllowanceTx. Sign it with your own Sui wallet to issue the allowance onchain; the agent can only spend inside its limits.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "allowance build failed" });
  }
});

// POST /api/allowance/revoke { userId, allowanceId? } -> UNSIGNED revocation
// PTB for the funder to sign. The revoke entry was verified live against
// the chain (0x2::allowance::revoke); the cap is discovered onchain.
app.post("/api/allowance/revoke", async (req: Request, res: Response) => {
  const { userId, allowanceId } = req.body as { userId?: string; allowanceId?: string };
  if (badUserId(res, userId)) return;
  try {
    const caps = await listCapsByOwner(userId as string);
    if (caps.length === 0) {
      res.status(404).json({ error: "No AllowanceCap objects found for this wallet." });
      return;
    }
    const cap =
      typeof allowanceId === "string" && allowanceId
        ? caps.find((c) => c.allowanceId.toLowerCase() === allowanceId.toLowerCase())
        : caps[0];
    if (!cap) {
      res.status(404).json({ error: "No matching AllowanceCap for that allowance id." });
      return;
    }
    const tx = buildRevokeTx({ funder: userId as string, capId: cap.capId, allowanceId: cap.allowanceId });
    const ops = await getChainOps();
    tx.setGasBudget(10_000_000n);
    tx.setGasPrice(await ops.getGasPrice());
    const bytes = await ops.buildTx(tx);
    res.json({
      unsignedTxBase64: Buffer.from(bytes).toString("base64"),
      capId: cap.capId,
      allowanceId: cap.allowanceId,
      transport: ops.transport,
      note: "Unsigned revocation PTB. Sign it with the funder wallet to revoke the allowance onchain; the agent cannot revoke on your behalf.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "revoke build failed" });
  }
});

// POST /api/payments/approve-build { paymentId } -> UNSIGNED funder-signed
// PTB that releases one awaiting_approval payment, plus a fee estimate.
// The funder's wallet signs; the agent never holds funder keys.
app.post("/api/payments/approve-build", async (req: Request, res: Response) => {
  const { paymentId } = req.body as { paymentId?: string };
  if (typeof paymentId !== "string" || !paymentId) {
    res.status(400).json({ error: "paymentId is required." });
    return;
  }
  try {
    const [row] = await db.select().from(agentPayments).where(eq(agentPayments.paymentId, paymentId));
    if (!row) {
      res.status(404).json({ error: "unknown payment." });
      return;
    }
    if (row.status !== "awaiting_approval") {
      res.status(400).json({ error: `only awaiting_approval payments can be approved (this one is ${row.status}).` });
      return;
    }
    for (const r of row.recipients) {
      const screen = await screenSuiAddress(r.address);
      if (screen.verdict === "blocked") {
        await db
          .update(agentPayments)
          .set({ status: "blocked", failureReason: screen.detail.slice(0, 500) })
          .where(eq(agentPayments.paymentId, paymentId));
        res.status(403).json({ error: `refused: ${screen.detail}` });
        return;
      }
    }
    const rate = await getSuiUsdRate();
    if (rate === null) {
      res.status(503).json({ error: "SUI/USD rate unavailable; try again." });
      return;
    }
    const totalUsd = Number(row.totalUsd);
    const tx = new Transaction();
    tx.setSender(row.userId);
    const totalMist = row.recipients.reduce((s, r) => s + usdToMist(r.amountUsd, rate), 0n);
    const balance = tx.balance({ balance: totalMist });
    const coin = tx.moveCall({
      target: "0x2::coin::from_balance",
      typeArguments: ["0x2::sui::SUI"],
      arguments: [balance],
    });
    if (row.recipients.length === 1) {
      tx.transferObjects([coin], row.recipients[0].address);
    } else {
      const parts = tx.splitCoins(
        coin,
        row.recipients.map((r) => usdToMist(r.amountUsd, rate)),
      );
      row.recipients.forEach((r, i) => tx.transferObjects([parts[i]], r.address));
    }
    const ops = await getChainOps();
    tx.setGasBudget(10_000_000n);
    tx.setGasPrice(await ops.getGasPrice());
    const bytes = await ops.buildTx(tx);
    const sim = await ops.simulateTx(bytes);
    res.json({
      unsignedTxBase64: Buffer.from(bytes).toString("base64"),
      amountUsd: totalUsd,
      recipients: row.recipients,
      simulationOk: sim.ok,
      simulationError: sim.error ?? null,
      gasEstimateUsd: Number(mistToUsd(sim.gasMist, rate).toFixed(4)),
      transport: ops.transport,
      note: "Sign these bytes with the funder wallet, then POST the digest to /api/payments/approve-confirm.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "approve build failed" });
  }
});

// POST /api/payments/approve-confirm { paymentId, digest } -> verify the
// funder-signed release onchain, then mark it settled.
app.post("/api/payments/approve-confirm", async (req: Request, res: Response) => {
  const { paymentId, digest } = req.body as { paymentId?: string; digest?: string };
  if (typeof paymentId !== "string" || typeof digest !== "string" || !paymentId || !digest) {
    res.status(400).json({ error: "paymentId and digest are required." });
    return;
  }
  try {
    const [row] = await db.select().from(agentPayments).where(eq(agentPayments.paymentId, paymentId));
    if (!row) {
      res.status(404).json({ error: "unknown payment." });
      return;
    }
    if (row.status !== "awaiting_approval") {
      res.status(400).json({ error: `only awaiting_approval payments can be confirmed (this one is ${row.status}).` });
      return;
    }
    const status = await getTransactionStatus(digest);
    if (status === "not_found") {
      res.json({ settled: false, pending: true, note: "digest not found yet; it may still be propagating." });
      return;
    }
    if (status === "failure") {
      await db
        .update(agentPayments)
        .set({ status: "failed", failureReason: `release tx ${digest} failed onchain` })
        .where(eq(agentPayments.paymentId, paymentId));
      res.json({ settled: false, pending: false });
      return;
    }
    const totalUsd = Number(row.totalUsd);
    await db
      .update(agentPayments)
      .set({ status: "settled", txHash: digest, settledAt: new Date() })
      .where(eq(agentPayments.paymentId, paymentId));
    await db.insert(transactions).values({
      userId: row.userId,
      merchantName: "agent payment",
      amountUsd: totalUsd.toFixed(4),
      source: "agent_payment",
      txHash: digest,
    });
    await recordPaymentMemory({
      userId: row.userId,
      totalUsd,
      status: "settled",
      standard: row.standard,
      recipientCount: row.recipients.length,
      digest,
    });
    res.json({ settled: true, pending: false, digest });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "approve confirm failed" });
  }
});

// ------------------------------------------------------------- bills

// GET /api/bills?userId=... -> scheduled bills, newest first
app.get("/api/bills", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (badUserId(res, userId)) return;
  try {
    const rows = await db
      .select()
      .from(scheduledBills)
      .where(eq(scheduledBills.userId, userId))
      .orderBy(desc(scheduledBills.createdAt))
      .limit(50);
    res.json(
      rows.map((r) => ({
        billId: r.billId,
        payeeName: r.payeeName,
        recipient: r.recipient,
        amountUsd: Number(r.amountUsd),
        frequency: r.frequency,
        nextDueAt: r.nextDueAt.getTime(),
        status: r.status,
        lastDigest: r.lastDigest ?? "",
        lastError: r.lastError ?? "",
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "bills failed" });
  }
});

// POST /api/bills { userId, payeeName, recipient, amountUsd, frequency } -> create
app.post("/api/bills", async (req: Request, res: Response) => {
  const { userId, payeeName, recipient, amountUsd, frequency, allowanceId } = req.body as {
    userId?: string;
    payeeName?: string;
    recipient?: string;
    amountUsd?: number;
    frequency?: string;
    allowanceId?: string;
  };
  if (badUserId(res, userId)) return;
  if (typeof payeeName !== "string" || !payeeName.trim()) {
    res.status(400).json({ error: "payeeName is required." });
    return;
  }
  if (frequency !== "once" && frequency !== "weekly" && frequency !== "monthly") {
    res.status(400).json({ error: "frequency must be once, weekly, or monthly." });
    return;
  }
  try {
    const bill = await createBill({
      userId: userId as string,
      payeeName,
      recipient: recipient ?? "",
      amountUsd: Number(amountUsd),
      frequency,
      allowanceId,
    });
    res.json({ billId: bill.billId, status: bill.status, nextDueAt: bill.nextDueAt.getTime() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "create bill failed" });
  }
});

// POST /api/bills/run { userId? } -> settle due bills now (demo trigger;
// the interval below also runs this on a schedule).
app.post("/api/bills/run", async (req: Request, res: Response) => {
  const { userId } = req.body as { userId?: string };
  if (userId !== undefined && (typeof userId !== "string" || !isValidSuiAddress(userId))) {
    res.status(400).json({ error: "userId must be a valid Sui wallet address." });
    return;
  }
  try {
    const results = await runBillPayPass(userId);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "bill run failed" });
  }
});

// ------------------------------------------------------------- dream

let dreamRunning = false;

// POST /api/dream/run -> one learning pass now (compaction + OCR drain).
app.post("/api/dream/run", async (_req: Request, res: Response) => {
  if (dreamRunning) {
    res.status(409).json({ error: "a dream pass is already running" });
    return;
  }
  dreamRunning = true;
  try {
    const dream = await runCompactDream();
    const ocr = await processQueuedUploads(10);
    res.json({ dream, ocr });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "dream failed" });
  } finally {
    dreamRunning = false;
  }
});

// POST /api/receipts (multipart: receipt file + userId) - accepted and
// queued immediately; the raw file uploads to the Walrus blob vault in
// the background and the sidecar records the blob id (or the honest
// error). The OCR vision provider is still outstanding: merchant and
// amount stay null until text exists (workers/asyncOcr.ts owns
// everything after text exists). Nothing here pretends OCR already ran.
const RECEIPTS_DIR = path.join(tmpdir(), "votoi-receipts");
const receiptSidecarPath = (sha: string) =>
  path.join(RECEIPTS_DIR, `${sha}.json`);

interface ReceiptStatus {
  receiptSha256: string;
  userId: string;
  filename: string;
  mimeType: string;
  status: "queued" | "processing" | "done" | "failed";
  merchant: string | null;
  amountUsd: number | null;
  error: string | null;
  blobId: string | null;
  vaultError: string | null;
  createdAt: string;
}

app.post("/api/receipts", upload.single("receipt"), (req: Request, res: Response) => {
  const userId = req.body?.userId as string | undefined;
  if (badUserId(res, userId)) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "receipt file is required." });
    return;
  }
  const sha = createHash("sha256").update(file.buffer).digest("hex");
  mkdirSync(RECEIPTS_DIR, { recursive: true });
  writeFileSync(path.join(RECEIPTS_DIR, `${sha}-${file.originalname}`), file.buffer);
  const sidecar: ReceiptStatus = {
    receiptSha256: sha,
    userId: userId as string,
    filename: file.originalname,
    mimeType: file.mimetype,
    status: "queued",
    merchant: null,
    amountUsd: null,
    error: null,
    blobId: null,
    vaultError: null,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(receiptSidecarPath(sha), JSON.stringify(sidecar));

  // Background: vault the raw file, then link it to the OCR queue row.
  const uid = userId as string;
  const buf: Buffer = file.buffer;
  const mime: string = file.mimetype;
  void (async () => {
    try {
      const vault = await uploadReceiptToVault(buf, mime);
      const current = JSON.parse(readFileSync(receiptSidecarPath(sha), "utf-8")) as ReceiptStatus;
      if (isVaultOk(vault)) {
        current.blobId = vault.blobId;
        try {
          await ensureUser(uid);
          await db.insert(mediaUploads).values({
            userId: uid,
            walrusBlobId: vault.blobId,
            mimeType: mime,
            kind: "receipt",
            ocrStatus: "queued",
          });
        } catch {
          // ledger link is best-effort; the vault blob id is the record
        }
      } else {
        current.vaultError = vault.error;
      }
      writeFileSync(receiptSidecarPath(sha), JSON.stringify(current));
    } catch {
      // sidecar keeps blobId null; the upload itself already succeeded
    }
  })();

  res.json({ queued: true, blobId: null, receiptSha256: sha });
});

// GET /api/receipts/:sha -> the local queue record for one uploaded receipt.
// 404 when the sha was never uploaded here. This reads only the sidecar;
// it never invents an OCR result.
app.get("/api/receipts/:sha", (req: Request, res: Response) => {
  const rawSha = req.params.sha;
  const sha = Array.isArray(rawSha) ? rawSha[0] : rawSha;
  const sidecarFile = receiptSidecarPath(sha);
  if (!/^[0-9a-f]{64}$/.test(sha) || !existsSync(sidecarFile)) {
    res.status(404).json({ error: "unknown receipt sha." });
    return;
  }
  try {
    res.json(JSON.parse(readFileSync(sidecarFile, "utf-8")) as ReceiptStatus);
  } catch {
    res.status(500).json({ error: "receipt status unreadable." });
  }
});

async function main(): Promise<void> {
  const vite = await createViteServer({
    root: appDir,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);

  const compactionMs = Number(process.env.COMPACTION_INTERVAL_MS ?? 600_000);
  if (compactionMs > 0) {
    let tickRunning = false;
    setInterval(() => {
      if (tickRunning) return;
      tickRunning = true;
      void (async () => {
        try {
          const dream = await runCompactDream();
          const ocr = await processQueuedUploads(10);
          let bills: BillRunResult[] = [];
          if (process.env.BILLPAY_AUTO_RUN !== "false") {
            bills = await runBillPayPass();
          }
          const mutated = dream.users.reduce((s, u) => s + u.merchantsMutated, 0);
          const settled = bills.filter((b) => b.status === "settled").length;
          console.log(
            `dream tick: users=${dream.users.length} mutated=${mutated} ocrDone=${ocr.done} billsSettled=${settled}`,
          );
        } catch (err) {
          console.warn(`dream tick failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          tickRunning = false;
        }
      })();
    }, compactionMs);
    console.log(`dream interval every ${compactionMs}ms`);
  }

  app.listen(PORT, () => {
    console.log(`VOTOI demo server on http://localhost:${PORT}`);
  });
}

void main();
