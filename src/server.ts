// VOTOI demo server: serves the Builder-generated React frontend (app/)
// and wires its /api/* routes to the real services - Neon cache, Walrus
// Memory Mainnet, and the Tatum Sui gateway. This replaces the Builder
// preview's mock routes (fake blob ids, fake digests, in-memory seeds):
// every value returned here comes from the database or the chain.
// Run: npx tsx src/server.ts  (PORT env, default 3000)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSuiAddress } from "@mysten/sui/utils";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { createServer as createViteServer } from "vite";
import { postChat } from "./api/chat.js";
import { postWipeCache } from "./api/test/wipe-cache.js";
import { walrusConfig, parseWatchdogFact } from "./config/walrus.js";
import { db } from "./db/client.js";
import { agentPayments } from "./db/schema.js";
import {
  buildIssueAllowanceTx,
  getAgentSpenderAddress,
} from "./services/agentPayments.js";
import {
  extractRevision,
  getCachedFacts,
  rehydrateUser,
} from "./services/rehydration.js";
import {
  findAllowancesForSpender,
  getSuiBalanceMist,
  getSuiUsdRate,
  mistToUsd,
  usdToMist,
} from "./services/suiReads.js";
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

// GET /api/status?userId=... -> allowance card + agent balance + relayer health
app.get("/api/status", async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (badUserId(res, userId)) return;
  // Chain reads go through the Tatum gateway. As of 2026-10-24 the
  // gateway answers HTTP 404 for every method with this project's key
  // (verified: even sui_getChainIdentifier 404s, while a bogus key gets
  // 401 - so the route, not the request, is missing). Never fail the
  // whole panel for that: fall back to the local ledger and mark the
  // chain fields unknown instead of inventing values.
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
        recipient: (r.recipients[0]?.address ?? "") as string,
        amountUsd: Number(r.totalUsd),
        status: r.status,
        digest: r.txHash ?? "",
        timestamp: (r.settledAt ?? r.createdAt).getTime(),
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "payments failed" });
  }
});

// POST /api/chat { userId, message } -> real agent (cache reads + ledger)
app.post("/api/chat", async (req: Request, res: Response) => {
  const { userId, message } = req.body as { userId?: string; message?: string };
  try {
    const result = await postChat({ user_id: userId, message });
    res.status(result.status).json({ reply: result.body.response });
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

// POST /api/allowance/revoke - NOT built from an unverified Move signature.
// The Builder mock claimed success with no transaction; this build refuses
// to fake it. Revocation is constructed once the allowance module's revoke
// entry point is verified live against the gateway.
app.post("/api/allowance/revoke", (_req: Request, res: Response) => {
  res.status(501).json({
    error:
      "Allowance revocation is not wired in this build: it must be signed by the funder with their own wallet, and the revoke entry point has not been verified live against the Tatum gateway (it 404s the normalized-function query).",
  });
});

// POST /api/receipts (multipart: receipt file + userId) - accepted and
// queued locally for the demo session. Walrus blob upload for receipts and
// the OCR vision provider are outstanding gaps (see docs/walrus-memory.md);
// the response claims nothing about a Walrus blob id.
app.post("/api/receipts", upload.single("receipt"), (req: Request, res: Response) => {
  const userId = req.body?.userId as string | undefined;
  if (badUserId(res, userId)) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "receipt file is required." });
    return;
  }
  const sha = createHash("sha256").update(file.buffer).digest("hex");
  const dir = path.join(tmpdir(), "votoi-receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sha}-${file.originalname}`), file.buffer);
  res.json({ queued: true, blobId: null, receiptSha256: sha });
});

async function main(): Promise<void> {
  const vite = await createViteServer({
    root: appDir,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  app.listen(PORT, () => {
    console.log(`VOTOI demo server on http://localhost:${PORT}`);
  });
}

void main();
