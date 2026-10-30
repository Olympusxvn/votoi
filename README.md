# VOTOI — Expense Watchdog Agent

An expense watchdog agent with long-term memory. Spending facts live in
Walrus Memory on Sui; wipe the cache and they restore straight from chain.
Payments move via onchain allowances, capped at $50 per transaction.

Built for the **Walrus x Tatum: Total Recall Hackathon, Track 2: Smart Agents
for Real Life**.

## What it does

- **Chat-first expense tracking.** Log spending in plain chat. Answers are
  grounded in learned facts, not generic advice.
- **Memory that survives the session.** Learned facts (merchant habits,
  budget risks, payment rules, preferences) are written to Walrus Memory
  Mainnet as the canonical store, with a Neon Postgres cache in front for
  fast reads. Chat stays under 2 seconds because it reads the cache; Walrus
  writes happen asynchronously.
- **Payments with a leash.** A funder issues a native Sui allowance naming
  the agent as spender, with onchain lifetime and rate limits. The agent
  spends through one atomic programmable transaction block, pays its own gas,
  and the funder can revoke at any time. No escrow, no sponsored gas, and
  nothing above $50 per transaction moves without a human in the loop.

## Demo walkthrough (Demo Mode bar in the UI)

1. **Log an expense in chat** — the agent records it and learns (or updates)
   a fact.
2. **Inspect the fact** — every fact carries its Walrus blob id, so the
   chain record is one click away.
3. **Wipe the cache** — `POST /api/test/wipe-cache` clears the local
   `learned_facts` table, then rehydrates it from Walrus. Same facts,
   rebuilt from chain.
4. **Allowance + pay** — build a real unsigned allowance transaction
   (`POST /api/allowance/build`), sign it with your own Sui wallet, then pay
   through it from chat.

## Architecture

Two tiers, one source of truth:

```
chat / UI (app/, React + Vite)
        │
        ▼
Express server (src/server.ts) ──► Neon Postgres + Drizzle (fast cache)
        │                              users, learned_facts, transactions,
        │                              media_uploads, chat_messages,
        │                              agent_payments, pending_writes,
        │                              sync_state
        ▼
Walrus Memory Mainnet (canonical, via @mysten-incubation/memwal)
```

- **Per-user namespace.** Each wallet gets its own namespace,
  `votoi-<wallet hex without 0x>`.
- **Fact format.** Facts are serialized pipe-delimited strings, with zero
  em-dashes (enforced by the serializer and a database check):

  ```
  [watchdog:fact_type] subject | pattern | rule
  ```

  where `fact_type` is `merchant_habit | budget_risk | payment_rule |
  preference. All money is USD.
- **Append-only versioning.** Walrus Memory has no update or delete, so a
  changed fact is written as a new revision. Ordering uses an embedded
  `rev N` marker, because `restore()` re-stamps restored memories with the
  restore time.
- **Durable writes.** Facts go through a `pending_writes` table with
  deterministic idempotency keys; recovery runs at the start of every pass,
  so a failed write is retried, not lost.
- **Chain reads.** Sui is reached through the Tatum hosted gateway RPC.
  Tatum Notifications does not support Sui, so payment confirmation uses RPC
  transaction-status checks instead of webhooks.

## Payments: native Sui allowances

1. Funder issues a Direct allowance (`sui::allowance`) naming the agent's
   spender address, with onchain lifetime/rate limits.
2. The agent spends in one atomic PTB: balance from the allowance, convert
   to a coin, split to the recipient. The spender pays gas.
3. The funder revokes anytime via the allowance cap.

See `src/services/agentPayments.ts` for the production path
(`buildIssueAllowanceTx`, `spendFromAllowance`, USD cap check, dry-run gate).

## API

| Route | What it does |
|---|---|
| `POST /api/chat` | Chat with the agent, grounded in learned facts |
| `GET /api/facts` | Learned facts from cache, with rehydrate fallback |
| `GET /api/status` | Allowance discovery, agent balance, relayer health |
| `GET /api/payments` | Settled payment ledger |
| `POST /api/test/wipe-cache` | Wipe cache, then immediately rehydrate from Walrus |
| `POST /api/allowance/build` | Build a real unsigned allowance-issuance transaction |
| `POST /api/allowance/revoke` | Intentionally `501` (see Limitations) |
| `POST /api/receipts` | Accept a receipt upload, queued locally (see Limitations) |

## Run locally

Prerequisites: Node.js and npm, a Neon Postgres database, a Tatum API key,
and a MemWal account.

```bash
npm install
cp .env.example .env   # fill it in; .env is gitignored and must never be committed
npm run db:push        # apply the Drizzle schema to DATABASE_URL
npm run dev            # serves the frontend + API (PORT env, default 3000)
npm run typecheck      # strict TypeScript check
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TATUM_API_KEY` | Yes | Tatum Sui gateway RPC |
| `MEMWAL_ACCOUNT_ID` | Yes | Walrus Memory account |
| `MEMWAL_PRIVATE_KEY` | Yes | MemWal delegate key (also the allowance spender) |
| `DATABASE_URL` | Yes | Neon Postgres connection |
| `SUI_NETWORK` | No | `mainnet` or `testnet` (defaults derive the rest) |
| `TATUM_SUI_RPC_URL` | No | Gateway URL override |
| `SUI_USD_RATE` | No | SUI/USD rate override |
| `VOTOI_AGENT_SUI_ADDRESS` | No | Dedicated agent wallet shown in status |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | No | Chat model configuration |

## Honest limitations

- **Revoke is `501` by design.** The revoke Move signature could not be
  verified live, so the endpoint refuses rather than fake a revocation.
- **Receipts queue locally.** `POST /api/receipts` stores the upload and
  returns its SHA-256; Walrus blob upload for receipts and the OCR vision
  provider are still outstanding, so no blob id is claimed.
- **Graceful degradation.** If chain reads are unavailable, `/api/status`
  reports `chainReadsUnavailable` and spent totals come from the local
  ledger instead of failing the whole panel.
- **Memory is append-only.** Corrections land as newer revisions; old facts
  are never deleted from Walrus.

## Layout

- `app/` — React + Vite + Tailwind frontend
- `src/server.ts` — Express server wiring every route to real services
- `src/services/` — Walrus rehydration, Sui reads, allowance payments
- `src/api/` — chat, facts, payments, allowance routes
- `src/workers/` — async OCR and background compaction
- `src/db/` — Drizzle client and schema
- `drizzle/` — migrations
- `scripts/` — probes, spikes, and test harnesses
- `docs/` — deeper notes, including `docs/walrus-memory.md` (two-tier
  architecture, fact format, revision protocol, failure case studies) and
  `docs/demo-recording-plan.md`
