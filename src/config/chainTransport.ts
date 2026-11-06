/**
 * Chain transport layer: Tatum-first with a public fallback.
 *
 * Transports, in priority order:
 *   1. "tatum-grpc" - Tatum native Sui gRPC gateway over TLS with the
 *      project x-api-key as call metadata (verified live 2026-11-06).
 *   2. "tatum"      - Tatum hosted Sui JSON-RPC gateway. Answers HTTP 404
 *      for this project's key (verified 2026-10-24 through 2026-11-06);
 *      kept so a recovery is picked up automatically.
 *   3. "public"     - Public Sui gRPC fullnode + GraphQL (no key).
 *
 * JSON-RPC-shaped callers (services/suiReads.ts) use chainCall(), which
 * keeps the legacy method names and adapts grpc/GraphQL answers back to
 * the legacy shapes. PTB callers (services/agentPayments.ts) use
 * getChainOps(), which binds build/simulate/execute/confirm to one
 * transport for the whole spend so a payment never straddles two.
 */
import { ChannelCredentials } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { parseTransactionEffectsBcs } from "@mysten/sui/client";
import {
  SuiJsonRpcClient,
  JsonRpcHTTPTransport,
} from "@mysten/sui/jsonRpc";
import type { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/bcs";
import { getTatumConfig, suiRpc, TatumRpcError } from "./tatum";

export type ChainTransportName = "tatum" | "tatum-grpc" | "public";
export type TransportHealth = "ok" | "down" | "unconfigured" | "unknown";

export interface TransportProbe {
  tatumJson: TransportHealth;
  tatumGrpc: TransportHealth;
  public: TransportHealth;
  active: ChainTransportName;
  checkedAt: number;
}

const PUBLIC_GRPC_URL =
  process.env.SUI_PUBLIC_GRPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const PUBLIC_GRAPHQL_URL =
  process.env.SUI_GRAPHQL_URL ?? "https://graphql.mainnet.sui.io/graphql";
const PROBE_TTL_MS = 60_000;

let cachedProbe: TransportProbe | null = null;
let lastTransport: ChainTransportName = "tatum-grpc";

export function tatumGrpcHost(): string {
  return process.env.TATUM_SUI_GRPC_HOST ?? "sui-mainnet-grpc.gateway.tatum.io:443";
}

/** Which transport served the most recent chain call (best-effort). */
export function getLastTransport(): ChainTransportName {
  return lastTransport;
}

// ------------------------------------------------------------------ clients

/** fetch wrapper that rides out HTTP 429 and transient 5xx with backoff. */
const fetchWithBackoff: typeof fetch = async (input, init) => {
  const delays = [1000, 2000, 4000, 8000];
  let last: Response | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    last = await fetch(input, init);
    if (last.status !== 429 && last.status < 500) return last;
    if (attempt < delays.length) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  return last as Response;
};

/** Legacy Tatum JSON-RPC client (kept for the PTB build path). */
export function getLegacyTatumClient(apiKey?: string): SuiJsonRpcClient {
  const key = apiKey ?? process.env.TATUM_API_KEY;
  const headers: Record<string, string> = {};
  if (key) headers["x-api-key"] = key;
  return new SuiJsonRpcClient({
    transport: new JsonRpcHTTPTransport({
      url: getTatumConfig().rpcUrl,
      fetch: fetchWithBackoff,
      rpc: { headers },
    }),
    network: "mainnet",
  });
}

let publicGrpc: SuiGrpcClient | null = null;
let tatumGrpc: SuiGrpcClient | null = null;

export function getPublicGrpcClient(): SuiGrpcClient {
  if (!publicGrpc) {
    publicGrpc = new SuiGrpcClient({
      network: "mainnet",
      baseUrl: PUBLIC_GRPC_URL,
    });
  }
  return publicGrpc;
}

/** Null only when TATUM_SUI_GRPC_HOST is explicitly blanked. */
export function getTatumGrpcClient(): SuiGrpcClient | null {
  const host = tatumGrpcHost();
  if (!host) return null;
  if (!tatumGrpc) {
    const key = process.env.TATUM_SUI_GRPC_KEY ?? process.env.TATUM_API_KEY ?? "";
    tatumGrpc = new SuiGrpcClient({
      network: "mainnet",
      transport: new GrpcTransport({
        host,
        channelCredentials: ChannelCredentials.createSsl(),
        meta: key ? { "x-api-key": key } : {},
      }),
    });
  }
  return tatumGrpc;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ------------------------------------------------------------------- probing

function pickActive(p: Omit<TransportProbe, "active" | "checkedAt">): ChainTransportName {
  if (p.tatumGrpc === "ok") return "tatum-grpc";
  if (p.tatumJson === "ok") return "tatum";
  if (p.public === "ok") return "public";
  return cachedProbe?.active ?? "tatum-grpc";
}

/**
 * Probe every transport (cached PROBE_TTL_MS). With allowProbe:false this
 * never touches the network: /api/health stays Tatum-free by design.
 */
export async function probeTransports(
  opts?: { allowProbe?: boolean },
): Promise<TransportProbe> {
  const now = Date.now();
  if (cachedProbe && now - cachedProbe.checkedAt < PROBE_TTL_MS) return cachedProbe;
  if (opts?.allowProbe === false) {
    return (
      cachedProbe ?? {
        tatumJson: "unknown",
        tatumGrpc: tatumGrpcHost() ? "unknown" : "unconfigured",
        public: "unknown",
        active: lastTransport,
        checkedAt: 0,
      }
    );
  }
  let tatumJson: TransportHealth = "down";
  try {
    await withTimeout(suiRpc<string>("sui_getChainIdentifier", []), 8000, "tatum probe");
    tatumJson = "ok";
  } catch {
    tatumJson = "down";
  }
  let tatumGrpcHealth: TransportHealth = tatumGrpcHost() ? "down" : "unconfigured";
  const tg = getTatumGrpcClient();
  if (tg) {
    try {
      await withTimeout(tg.getChainIdentifier(), 8000, "tatum-grpc probe");
      tatumGrpcHealth = "ok";
    } catch {
      tatumGrpcHealth = "down";
    }
  }
  let publicHealth: TransportHealth = "down";
  try {
    await withTimeout(getPublicGrpcClient().getChainIdentifier(), 8000, "public probe");
    publicHealth = "ok";
  } catch {
    publicHealth = "down";
  }
  cachedProbe = {
    tatumJson,
    tatumGrpc: tatumGrpcHealth,
    public: publicHealth,
    active: pickActive({ tatumJson, tatumGrpc: tatumGrpcHealth, public: publicHealth }),
    checkedAt: now,
  };
  lastTransport = cachedProbe.active;
  return cachedProbe;
}

// ------------------------------------------------------------- graphql reads

export async function suiGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(PUBLIC_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new TatumRpcError(`GraphQL fallback HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new TatumRpcError(body.errors[0].message);
  return body.data as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * GraphQL contents.json is flat ({ settings: {...}, current_spend }),
 * legacy JSON-RPC nests Move structs ({ settings: { fields: {...} } }).
 * Wrap one level so legacy parsers keep working.
 */
function adaptGraphqlFields(json: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    out[k] =
      typeof v === "object" && v !== null && !Array.isArray(v) ? { fields: v } : v;
  }
  return out;
}

async function fallbackObject(objectId: string): Promise<Record<string, unknown>> {
  const data = await suiGraphql<{
    object?: {
      version?: string;
      digest?: string;
      asMoveObject?: { contents?: { json?: Record<string, unknown> } };
    } | null;
  }>(
    `query($id: SuiAddress!) {
      object(address: $id) {
        version digest
        asMoveObject { contents { json } }
      }
    }`,
    { id: objectId },
  );
  const obj = data.object;
  if (!obj?.asMoveObject?.contents?.json) {
    throw new TatumRpcError(`fallback object not found: ${objectId}`);
  }
  return {
    data: {
      objectId,
      version: obj.version,
      digest: obj.digest,
      content: { fields: adaptGraphqlFields(obj.asMoveObject.contents.json) },
    },
  };
}

export interface FallbackCap {
  capId: string;
  allowanceId: string;
}

/** Every AllowanceCap `owner` holds, with the allowance each one governs. */
export async function listCapsByOwner(owner: string): Promise<FallbackCap[]> {
  const data = await suiGraphql<{
    objects?: { nodes?: Array<{ address?: string; asMoveObject?: { contents?: { json?: { allowance?: string } } } }> };
  }>(
    `query($o: SuiAddress!) {
      objects(first: 25, filter: {owner: $o, type: "0x2::allowance::AllowanceCap"}) {
        nodes { address asMoveObject { contents { json } } }
      }
    }`,
    { o: owner },
  );
  const out: FallbackCap[] = [];
  for (const n of data.objects?.nodes ?? []) {
    const allowance = n.asMoveObject?.contents?.json?.allowance;
    if (typeof n.address === "string" && typeof allowance === "string") {
      out.push({ capId: n.address, allowanceId: allowance });
    }
  }
  return out;
}

/** Independent confirmation of one digest (cross-checks grpc waitFor). */
export async function graphqlTxStatus(
  digest: string,
): Promise<"success" | "failure" | "not_found"> {
  try {
    const data = await suiGraphql<{
      transaction?: { effects?: { status?: string } } | null;
    }>(
      `query($d: String!) { transaction(digest: $d) { effects { status } } }`,
      { d: digest },
    );
    const st = data.transaction?.effects?.status;
    if (st === "SUCCESS") return "success";
    if (st === "FAILED") return "failure";
    return "not_found";
  } catch {
    return "not_found";
  }
}

// ------------------------------------------------------- legacy-shaped call

/** Methods the grpc/GraphQL adapter can answer in legacy shape. */
async function adapterCall(
  grpc: SuiGrpcClient,
  method: string,
  params: unknown[],
): Promise<unknown> {
  switch (method) {
    case "sui_getChainIdentifier": {
      const r = (await grpc.getChainIdentifier()) as unknown as { chainIdentifier: string };
      return r.chainIdentifier;
    }
    case "suix_getBalance": {
      const [owner, coinType] = params as [string, string?];
      const r = (await grpc.getBalance({
        owner,
        coinType: coinType ?? "0x2::sui::SUI",
      })) as unknown as { balance: { balance: string } };
      return { totalBalance: r.balance.balance };
    }
    case "sui_getObject": {
      const [objectId] = params as [string];
      return fallbackObject(objectId);
    }
    case "suix_getOwnedObjects": {
      const [owner, opts] = params as [string, { filter?: { StructType?: string } }?];
      if (opts?.filter?.StructType !== "0x2::allowance::AllowanceCap") {
        throw new TatumRpcError(`fallback cannot serve filter ${JSON.stringify(opts?.filter)}`);
      }
      const caps = await listCapsByOwner(owner);
      return {
        data: caps.map((c) => ({
          data: {
            objectId: c.capId,
            content: { fields: { allowance: c.allowanceId } },
          },
        })),
        nextCursor: null,
        hasNextPage: false,
      };
    }
    case "sui_getTransactionBlock": {
      const [digest] = params as [string];
      try {
        const tx = (await grpc.getTransaction({
          digest,
          include: { effects: true },
        })) as unknown as Record<string, unknown>;
        const status = statusSuccess(tx);
        return { digest, effects: { status: { status: status ? "success" : "failure" } } };
      } catch {
        throw new TatumRpcError(`fallback tx not found: ${digest}`);
      }
    }
    default:
      throw new TatumRpcError(`fallback cannot serve ${method}`);
  }
}

function statusSuccess(tx: Record<string, unknown>): boolean {
  const inner = asRecord(tx["Transaction"] ?? tx["transaction"]);
  const s1 = asRecord(inner["status"])["success"] ?? asRecord(tx["status"])["success"];
  if (s1 === true) return true;
  if (s1 === false) return false;
  const s2 =
    asRecord(asRecord(tx["effects"])["status"])["status"] ??
    asRecord(asRecord(inner["effects"])["status"])["status"];
  if (s2 === "success") return true;
  if (typeof s2 === "string") return false;
  throw new TatumRpcError("fallback cannot parse tx status");
}

/**
 * One Sui JSON-RPC call through the active transport, failing over to the
 * rest in order. Returns the legacy result shape; the serving transport is
 * visible via getLastTransport().
 */
export async function chainCall<T>(method: string, params: unknown[]): Promise<T> {
  const probe = await probeTransports();
  const order: ChainTransportName[] = [
    probe.active,
    ...(["tatum-grpc", "tatum", "public"] as ChainTransportName[]).filter(
      (t) => t !== probe.active,
    ),
  ];
  let lastErr: unknown = null;
  for (const name of order) {
    try {
      let result: unknown;
      if (name === "tatum") {
        result = await suiRpc<T>(method, params);
      } else if (name === "tatum-grpc") {
        const tg = getTatumGrpcClient();
        if (!tg) continue;
        result = await adapterCall(tg, method, params);
      } else {
        result = await adapterCall(getPublicGrpcClient(), method, params);
      }
      lastTransport = name;
      return result as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`chain ${method} failed on all transports`);
}

// ------------------------------------------------------------------ PTB ops

export interface ChainOps {
  transport: ChainTransportName;
  getGasPrice(): Promise<bigint>;
  buildTx(tx: Transaction): Promise<Uint8Array>;
  simulateTx(bytes: Uint8Array): Promise<{ ok: boolean; error?: string; gasMist: bigint }>;
  executeTx(bytes: Uint8Array, signature: string): Promise<{ digest: string | null }>;
  confirmTx(digest: string): Promise<{ gasMist: bigint }>;
}

function walkGasUsed(v: unknown): bigint | null {
  const r = asRecord(v);
  const g = asRecord(r["gasUsed"]);
  const c = g["computationCost"] ?? r["computationCost"];
  const s = g["storageCost"] ?? r["storageCost"];
  const rb = g["storageRebate"] ?? r["storageRebate"];
  if (typeof c !== "string" || typeof s !== "string" || typeof rb !== "string") return null;
  try {
    return BigInt(c) + BigInt(s) - BigInt(rb);
  } catch {
    return null;
  }
}

function effectsGasMist(node: unknown): bigint {
  const bcs = asRecord(asRecord(node)["effects"])["bcs"];
  if (bcs instanceof Uint8Array) {
    try {
      const parsed = parseTransactionEffectsBcs(bcs);
      return walkGasUsed(parsed) ?? 0n;
    } catch {
      return 0n;
    }
  }
  return walkGasUsed(asRecord(node)["effects"]) ?? walkGasUsed(node) ?? 0n;
}

function grpcSimStatus(sim: unknown): { ok: boolean; error?: string } {
  const r = asRecord(sim);
  const inner = asRecord(r["Transaction"] ?? r["transaction"]);
  const status = asRecord(inner["status"])["success"] ?? asRecord(r["status"])["success"];
  if (status === true) return { ok: true };
  if (status === false) {
    const err = asRecord(inner["status"])["error"] ?? asRecord(r["status"])["error"];
    return { ok: false, error: typeof err === "string" ? err : "simulation failed" };
  }
  throw new TatumRpcError("fallback cannot parse simulation status");
}

function grpcOps(transport: ChainTransportName, grpc: SuiGrpcClient): ChainOps {
  return {
    transport,
    async getGasPrice() {
      const r = (await grpc.getReferenceGasPrice()) as unknown as { referenceGasPrice: string };
      return BigInt(r.referenceGasPrice);
    },
    async buildTx(tx) {
      // Read-only: retry through free-plan 429 bursts (build resolvers
      // fan out several RPCs at once).
      let lastErr: unknown = null;
      for (const waitMs of [0, 15000, 30000, 60000]) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        try {
          return await tx.build({ client: grpc });
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
    async simulateTx(bytes) {
      // Read-only: safe to retry through free-plan 429 bursts.
      let lastErr: unknown = null;
      for (const waitMs of [0, 10000, 20000, 40000]) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        try {
          const sim = await grpc.simulateTransaction({
            transaction: bytes,
            include: { effects: true },
          });
          const st = grpcSimStatus(sim);
          const node = asRecord((sim as unknown as Record<string, unknown>)["Transaction"]);
          return { ...st, gasMist: effectsGasMist(Object.keys(node).length ? node : sim) };
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
    async executeTx(bytes, signature) {
      // Exactly-once: the ONLY retried error is an explicit 429
      // rejection (the tx never entered the mempool). Any other error
      // has an uncertain outcome and is never retried blindly.
      let lastErr: unknown = null;
      for (const waitMs of [0, 30000, 60000, 90000]) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        try {
          const res = (await grpc.executeTransaction({
            transaction: bytes,
            signatures: [signature],
            include: { effects: true },
          })) as unknown as Record<string, unknown>;
          const d =
            res["digest"] ??
            asRecord(res["Transaction"])["digest"] ??
            asRecord(res["transaction"])["digest"];
          return { digest: typeof d === "string" ? d : null };
        } catch (err) {
          lastErr = err;
          if (!(err instanceof Error) || !err.message.includes("429")) throw err;
        }
      }
      throw lastErr;
    },
    async confirmTx(digest) {
      const parseDone = (done: Record<string, unknown>): { gasMist: bigint } => {
        const node = asRecord(done["Transaction"] ?? done["transaction"]);
        const st = Object.keys(node).length ? node : done;
        const ok = asRecord(asRecord(st)["status"])["success"];
        if (ok === false) {
          throw new Error(`tx ${digest} failed onchain`);
        }
        return { gasMist: effectsGasMist(asRecord(st)["effects"] !== undefined ? st : done) };
      };
      try {
        const done = (await grpc.waitForTransaction({
          digest,
          include: { effects: true },
        })) as unknown as Record<string, unknown>;
        return parseDone(done);
      } catch (err) {
        let last: unknown = err;
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 10000));
          try {
            const tx = (await grpc.getTransaction({
              digest,
              include: { effects: true },
            })) as unknown as Record<string, unknown>;
            return parseDone(tx);
          } catch (e2) {
            last = e2;
          }
        }
        throw new Error(`confirm uncertain for ${digest}: check the digest before retrying`);
      }
    },
  };
}

function legacyOps(client: SuiJsonRpcClient): ChainOps {
  return {
    transport: "tatum",
    async getGasPrice() {
      return BigInt(await client.getReferenceGasPrice());
    },
    async buildTx(tx) {
      return tx.build({ client });
    },
    async simulateTx(bytes) {
      const dry = await client.dryRunTransactionBlock({ transactionBlock: toBase64(bytes) });
      const gas = dry.effects.gasUsed;
      const gasMist =
        BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
      if (dry.effects.status.status !== "success") {
        return { ok: false, error: dry.effects.status.error ?? "simulation failed", gasMist };
      }
      return { ok: true, gasMist };
    },
    async executeTx(bytes, signature) {
      const res = await client.executeTransactionBlock({
        transactionBlock: toBase64(bytes),
        signature,
        options: { showEffects: true },
      });
      return { digest: res.digest };
    },
    async confirmTx(digest) {
      const done = await client.waitForTransaction({ digest, options: { showEffects: true } });
      if (done.effects?.status?.status !== "success") {
        throw new Error(`tx ${digest} failed onchain: ${done.effects?.status?.error ?? digest}`);
      }
      const gas = done.effects.gasUsed;
      return {
        gasMist: BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate),
      };
    },
  };
}

/** Ops bound to the active transport for one whole spend. */
export async function getChainOps(): Promise<ChainOps> {
  const probe = await probeTransports();
  if (probe.active === "tatum-grpc") {
    const tg = getTatumGrpcClient();
    if (tg) {
      try {
        await withTimeout(tg.getChainIdentifier(), 8000, "tatum-grpc check");
        lastTransport = "tatum-grpc";
        return grpcOps("tatum-grpc", tg);
      } catch {
        // fall through to the rest below
      }
    }
  }
  if (probe.active === "tatum") {
    try {
      await withTimeout(suiRpc<string>("sui_getChainIdentifier", []), 8000, "tatum check");
      lastTransport = "tatum";
      return legacyOps(getLegacyTatumClient());
    } catch {
      // fall through to public below
    }
  }
  lastTransport = "public";
  return grpcOps("public", getPublicGrpcClient());
}

/** Ops bound to an explicitly provided legacy client (scripts/tests). */
export function chainOpsForLegacy(client: SuiJsonRpcClient): ChainOps {
  return legacyOps(client);
}
