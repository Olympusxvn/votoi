# VOTOI - Expense Watchdog Agent

An expense watchdog that remembers everything you teach it and can pay
within limits you set onchain. Spending facts live in Walrus Memory on
Sui mainnet; payments move through native Sui allowances, never through
an escrow or a custodial balance.

Built for the **Walrus x Tatum: Total Recall Hackathon, Track 2: Smart
Agents for Real Life**.

## Two pillars

**Memory on Walrus Mainnet.** 12 facts, 12 distinct blobs, one namespace per wallet. Walrus is the canonical store; Postgres is only a volatile cache. Wipe the cache and the same facts rebuild from chain. Every deterministic chat answer cites its facts by blob id.

**Payments via Sui allowances, x402-style.** The agent never holds your funds: it spends from a native Sui allowance in one atomic PTB, spender pays gas, capped at 50.00 USD with over-limit payments recorded as `awaiting_approval` and never sent. Settled proof: 0.01 USD paid from chat ([Suiscan](https://suiscan.xyz/mainnet/tx/BDFfAHCMFFNnk5ERmBxqndZvin7NTTXXxPHJgUsFudrh)).


## Verify it in 60 seconds

A judge does not have to take anything below on trust. Each claim has a
check that runs in under a minute:

1. **Memory is real.** `GET /api/health` reports the cached fact count
   and the relayer status. As of Nov 4, 2026: 12 facts cached, 12 distinct
   Walrus blobs, relayer healthy.
2. **Memory is canonical.** In the UI, demo step 3 opens the wipe
   dialog; confirming destroys the local cache, then rebuilds the same
   facts from Walrus and reports how many were restored
   (`POST /api/test/wipe-cache`).
3. **Payments are real.** A chat payment of 0.01 USD settled through the
   production allowance:
   [Suiscan transaction](https://suiscan.xyz/mainnet/tx/BDFfAHCMFFNnk5ERmBxqndZvin7NTTXXxPHJgUsFudrh).
4. **Answers cite their sources.** Ask "What do you know about my coffee
   habit?" and the reply lists the exact facts used, each with its Walrus
   blob id. Citations appear only when the answer's sources are known
   exactly; the LLM path never gets invented citations.

## What it does

- **Chat-first expense tracking.** Log spending in plain chat. Answers
  are grounded in learned facts, not generic advice, and every fact used
  is cited by its Walrus blob id.
- **Memory that outlives the session.** Learned facts (merchant habits,
  budget risks, payment rules, preferences) are written to Walrus Memory
  Mainnet as the canonical store. A Neon Postgres cache sits in front for
  fast reads, so chat answers from cache within a 2 second budget while
  Walrus writes happen asynchronously.
- **Payments with a leash.** A funder issues a native Sui allowance
  naming the agent as spender, with onchain lifetime and rate limits.
  The agent spends through one atomic programmable transaction block,
  pays its own gas, and the funder can revoke at any time. Nothing above
  50.00 USD per transaction moves without a human in the loop: over-limit
  payments are recorded as `awaiting_approval` and never sent.
- **Receipts, honestly async.** Upload a receipt and the UI follows its
  real queue status (queued, processing, done, failed). No blob id is
  claimed for receipts, because receipt uploads are not Walrus facts
  (see Limitations).

## Proof, not promises

| Claim | Evidence |
|---|---|
| 12 facts on Walrus Memory Mainnet | `GET /api/health`, Nov 4, 2026: 12 facts cached, 12 distinct blobs |
| Memory is the source of truth, not the cache | Wipe-cache rehydrate restores the same facts from Walrus |
| Agent paid through an allowance | Settled 0.01 USD chat payment, digest linked above |
| Production allowance | `0x7a8d2e5abf179e66966125acb5796ea3b9649ddd949e8a63200a88c88cae1993` |
| Over-limit payments are never auto-sent | `awaiting_approval` rows in `GET /api/payments`, amber card in chat |
| Every answer is checkable | Chat citations carry subject plus Walrus blob id |

## How it works

Two tiers, one source of truth:

```
chat / UI (app/, React + Vite)
        |
        v
Express server (src/server.ts) --> Neon Postgres + Drizzle (fast cache)
        |                              users, learned_facts, transactions,
        |                              media_uploads, chat_messages,
        |                              agent_payments, pending_writes,
        |                              sync_state
        v
Walrus Memory Mainnet (canonical, via @mysten-incubation/memwal)
        ^
        |  async OCR worker drains media_uploads once text exists;
        |  compaction worker maintains the cache
```

### Memory: facts, revisions, durable writes

- **Per-user namespace.** Each wallet gets its own namespace,
  `votoi-<wallet hex without 0x>`.
- **Fact format.** Facts are serialized pipe-delimited strings, with
  zero em-dashes (enforced by the serializer and a database check):

  ```
  [watchdog:fact_type] subject | pattern | rule
  ```

  where `fact_type` is `merchant_habit | budget_risk | payment_rule |
  preference. All money is USD.
- **Append-only versioning.** Walrus Memory has no update or delete, so
  a changed fact is written as a new revision. Ordering uses an embedded
  `rev N` marker, because `restore()` re-stamps restored memories with
  the restore time.
- **Durable writes.** Facts go through a `pending_writes` table with
  deterministic idempotency keys; recovery runs at the start of every
  pass, so a failed write is retried, not lost.
- **Chat grounding.** Questions are answered from cached facts. If an
  LLM key is configured, it drafts from the same facts with a 1.5 second
  timeout; otherwise, and on any LLM failure, a deterministic composer
  answers. Citations are attached only on paths where the facts used are
  known exactly.

### Payments: native Sui allowances

1. The funder issues a Direct allowance (`sui::allowance`) naming the
   agent's spender address, with onchain lifetime and rate limits.
2. The agent spends in one atomic PTB: balance from the allowance,
   converted to a coin, split to the recipients. The spender pays gas.
3. The funder revokes anytime via the allowance cap (see Limitations
   for the current status of the revoke endpoint).
4. Safety is enforced twice: the onchain allowance limits, and the
   code path that refuses over-cap spends (chat records them as
   `awaiting_approval`; the payment service throws
   `HumanApprovalRequired`).

See `src/services/agentPayments.ts` for the production path
(`buildIssueAllowanceTx`, `spendFromAllowance`, USD cap check, dry-run
gate). Chain reads go through the Tatum hosted gateway RPC. Tatum
Notifications does not support Sui, so payment confirmation uses RPC
transaction-status checks instead of webhooks.

### Demo walkthrough (Demo Mode bar in the UI)

1. **Log an expense in chat** - the agent records it and learns (or
   updates) a fact.
2. **Inspect the fact** - every fact carries its Walrus blob id, so the
   chain record is one click away.
3. **Wipe the cache** - `POST /api/test/wipe-cache` clears the local
   `learned_facts` table, then rehydrates it from Walrus. Same facts,
   rebuilt from chain.
4. **Allowance + pay** - build a real unsigned allowance transaction
   (`POST /api/allowance/build`), sign it with your own Sui wallet, then
   pay through it from chat.
5. **Receipt upload** - drop a receipt and follow its live queue status
   in the chat panel.

## API

| Route | What it does |
|---|---|
| `GET /api/health` | Judge-verifiable numbers: cached facts, distinct Walrus blobs, relayer status, gateway note. Never probes Tatum per call |
| `POST /api/chat` | Chat with the agent, grounded in learned facts, with citations and the payment action |
| `GET /api/facts` | Learned facts from cache, with rehydrate fallback |
| `GET /api/status` | Allowance discovery, agent balance, relayer health |
| `GET /api/payments` | Payment ledger, including split recipients and `awaiting_approval` rows |
| `POST /api/test/wipe-cache` | Wipe cache, then immediately rehydrate from Walrus |
| `POST /api/allowance/build` | Build a real unsigned allowance-issuance transaction |
| `POST /api/allowance/revoke` | Intentionally `501` (see Limitations) |
| `POST /api/receipts` | Accept a receipt upload, queued locally (see Limitations) |
| `GET /api/receipts/:sha` | Live queue status for one uploaded receipt |

## Prize mapping

| Prize | What VOTOI shows for it |
|---|---|
| Best Walrus Memory | Walrus is the canonical store, not a cache: 12 facts, per-user namespaces, append-only revisions, wipe-cache rehydrate proof, blob ids on every fact |
| Best Tatum AI Builder App | The UI scaffold and early service modules were generated with Tatum AI Builder prompts (`docs/ai-builder-prompts.md`); the demo server then replaced every mock route with real services, so no demo value is faked |
| Best Use of Agent Payments | Native Sui allowances with onchain limits, one atomic PTB per spend, spender-paid gas, 50.00 USD auto-pay cap with `awaiting_approval`, and a settled onchain payment to prove it |

## Run locally

Prerequisites: Node.js and npm, a Neon Postgres database, a Tatum API
key, and a MemWal account.

```bash
npm install
cp .env.example .env   # fill it in; .env is gitignored and must never be committed
npm run db:push        # apply the Drizzle schema to DATABASE_URL
npm run dev            # serves the frontend + API (PORT env, default 3000)
npm run typecheck      # strict TypeScript check
```

The UI prefills a demo wallet address; replace it with any Sui wallet
address to drive every panel.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TATUM_API_KEY` | Yes | Tatum Sui gateway RPC |
| `MEMWAL_ACCOUNT_ID` | Yes | Walrus Memory account |
| `MEMWAL_PRIVATE_KEY` | Yes | MemWal delegate key (server only) |
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
  provider are still outstanding, so no blob id is claimed for receipts.
- **Gateway incident, stated plainly.** As of Nov 4, 2026, the generic
  Tatum gateway returns HTTP 404 for Sui methods with this project's key
  (re-verified with a single call that day). Panels do not fail on it:
  `/api/status` reports `chainReadsUnavailable` and spent totals come
  from the local ledger.
- **Memory is append-only.** Corrections land as newer revisions; old
  facts are never deleted from Walrus.

## Layout

- `app/` - React + Vite + Tailwind frontend
- `src/server.ts` - Express server wiring every route to real services
- `src/services/` - Walrus rehydration, Sui reads, allowance payments
- `src/api/` - chat, facts, payments, allowance routes
- `src/workers/` - async OCR and background compaction
- `src/db/` - Drizzle client and schema
- `drizzle/` - migrations
- `scripts/` - probes, spikes, and test harnesses
- `docs/` - deeper notes, including `docs/walrus-memory.md` (two-tier
  architecture, fact format, revision protocol, failure case studies) and
  `docs/demo-recording-plan.md`
