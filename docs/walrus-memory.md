# How VOTOI uses Walrus Memory

*For the Total Recall Hackathon judges. This document describes the memory
design of VOTOI (Expense Watchdog Agent, Track 2) as actually implemented
and verified live on Mainnet - module names refer to this repository.*

## 1. Role in the architecture: canonical truth, not a cache

VOTOI stores memory in two tiers with a strict rule about which one is
believed:

| Tier | Technology | Role |
| --- | --- | --- |
| Canonical | **Walrus Memory (MemWal) on Mainnet** | The only source of truth for everything the agent has "learned" |
| Fast cache | Neon Postgres (Drizzle ORM) | Volatile, rebuildable index of the canonical tier for sub-2-second chat |

A fact counts as learned **only once its blob exists on Walrus**
(`learned_facts.walrus_blob_id` is set). Postgres rows are pointers:
`(user, fact_type, subject) -> current serialized fact + blob id + version`.
Delete the whole Postgres database and the agent rebuilds its mind from
Walrus alone (section 5) - this is demoed live with a wipe-cache endpoint.

Each user gets an isolated MemWal namespace, `votoi-<wallet address>`,
served by one delegate key and one MemWal account.

## 2. The fact format

Every memory is one flat, pipe-delimited string, identical on Walrus, in
Postgres, and in the LLM context:

```
[watchdog:fact_type] subject | pattern | rule
```

- `fact_type` is one of `merchant_habit`, `budget_risk`, `payment_rule`,
  `preference`.
- Em-dashes are **rejected** at three layers: the serializer
  (`serializeWatchdogFact` in `src/config/walrus.ts`), the write path, and
  a Postgres `CHECK` constraint - formatting can never drift between the
  chat UI, a Telegram client, and the chain.
- All amounts are USD, everywhere.

Example (a real fact written during development):

```
[watchdog:payment_rule] agent autopay | agent may auto pay approved expense splits onchain | require human approval for any agent payment above 50 USD per transaction
```

## 3. The agent learns, it does not just accumulate

Raw transactions never become memories. A background worker
(`src/workers/compactDream.ts`) condenses the ledger into a small set of
evolving **beliefs**, one per `(fact_type, subject)` slot:

- **Mutation, not accumulation.** When a merchant reaches 5 transactions,
  their habit is recomputed (frequency per week, average USD) and the
  fact is rewritten as a new blob. The pattern segment ends with
  `rev N`; the Postgres slot flips its pointer to the new revision.
  Walrus is append-only, so superseded revisions remain on-chain as an
  **auditable belief history** - judges can watch a belief evolve.
- **Why the revision lives in the text:** MemWal `restore()` stamps
  restored memories with the restore time as `created_at` (upstream
  issue #1060), so timestamps cannot order versions after a restore.
  The embedded `rev N` can, and rehydration deduplicates by it.
- **Evidence counts.** Every habit pattern carries `evidence N txs` -
  the number of ledger transactions consolidated into the belief
  (inspired by the Observations concept in vectorize-io/hindsight).
  A belief states how much proof stands behind it.
- **A mental model.** The same worker maintains one standing
  `spending profile` fact per user - monthly spend, top merchants,
  evidence total, and the top thing to watch - re-synthesized in the
  background whenever the ledger moves. The chat agent reads it first,
  so it boots from settled knowledge instead of re-deriving a picture
  on every turn. The rule segment of a mutated habit is always
  preserved verbatim: rules are user intent, patterns are statistics,
  and the dream loop only rewrites statistics.
- **No delta, no write.** If recomputation produces the identical
  string, nothing is written to Walrus. Compaction, not accumulation.

## 4. Writes are durable: intent, job, receipt

A MemWal `remember()` is an asynchronous job: the relayer accepts it,
then embeds, encrypts, and uploads the blob. That gap is where naive
integrations lose writes (process restart, serverless timeout, relayer
failure). VOTOI persists through it, in a dedicated `pending_writes`
table (the pattern the project owner field-tested in the WalPen app and
filed upstream as MystenLabs/walrus-memory #1048 and #1049):

1. Persist the frozen intent: serialized fact + **deterministic
   idempotency key** (`sha256(namespace + content)`).
2. Submit to MemWal; record the accepted `job_id` on the same row.
3. Await the job; only then flip the fact to `active` with its blob id
   and delete the intent row.

Recovery runs at the start of every compaction pass
(`recoverPendingWrites`): jobs found `done` are finalized from their
receipt, `failed`/`not_found` intents are dropped (the next pass
recomputes from the ledger), and intents that crashed before acceptance
are resubmitted with the **same** idempotency key, which collapses onto
the original relayer job instead of paying for a duplicate blob. All
four branches were exercised live - including during the incident below.

## 5. Rehydration: a cold start rebuilds the mind from Walrus

`src/services/rehydration.ts` gates every chat turn. Warm cache: one
Postgres read, chat proceeds. Cold cache (new device, wiped demo): the
pipeline halts and rebuilds first -

1. `restore(namespace)` re-indexes the user's on-chain blobs into the
   relayer (it returns counts, not texts).
2. Four broad per-type semantic recalls fetch the fact texts.
3. Facts are parsed, deduplicated per slot keeping the **highest
   embedded revision**, and upserted into the cache; `sync_state`
   records when and how many.

Verified live on 2026-10-21: cold rebuild restored 11/11 facts; a full
wipe followed by a second rebuild again produced 11/11.

## 6. Latency design, mapped to upstream issues

Interactive recall against a hosted relayer takes seconds, and a
confirmed `remember()` takes tens of seconds - far beyond a chat budget
(the project owner filed these upstream: #1164 cache-first recall,
#1165 blocking remember vs serverless budgets, #1166 intent gate).
VOTOI's answers are architectural, not hopeful:

- Chat **never** calls `recall()` on a warm cache and **never** writes
  memory synchronously; all writes live in background workers.
- Deterministic intents (log expense, pay) run before any model call;
  questions are answered from cached facts.
- If Walrus is unreachable during a cold rebuild, chat degrades to an
  explicitly labeled no-memory answer instead of dying - availability
  without pretending.

## 7. Failure modes, observed live - not hypothetical

- **2026-09-19 (upstream #1047):** 3 of 5 accepted remember jobs failed
  with the relayer's encryption backend unavailable.
- **2026-10-22 (during this build):** the relayer's embedding backend
  rejected writes with `401 Unauthorized` and recall returned 500s for
  several hours. VOTOI's behavior, verified live mid-incident: chat
  kept answering from the Neon cache; the two compaction writes failed
  closed with their intents and job ids preserved in `pending_writes`;
  recovery finalized an idempotent replay from its original job and
  dropped the dead jobs. Nothing was lost and nothing was duplicated.

The design assumption throughout: **the relayer is a dependency that
will fail; the memory must not.**

## 8. What is verified on Mainnet today

- 11 watchdog facts written to Walrus Memory Mainnet in the demo user's
  namespace (blob ids recorded in `scripts/spike-memwal-results.json`),
  exceeding the 10-memory submission requirement; semantic recall
  returns the right fact first for natural questions.
- The full loop - chat, expense logging, compaction inputs, cache wipe,
  rehydration, agent payments via Sui allowances - runs end to end
  (`scripts/test-phase2.ts`, `scripts/test-compact.ts`).
- Payments settle through native Sui allowances issued via the Tatum
  RPC gateway (see the submission README for digests); memory and money
  meet in one rule: the autopay fact above is both a Walrus memory and
  the enforced behavior of the payment path (50 USD cap in code, in the
  database `CHECK`, and in the on-chain allowance limits).

## 9. Honest limitations

- The canonical tier inherits MemWal's current limits: append-only (no
  deletion), semantic-only recall, and relayer availability as above.
- The mental model is deliberately one concise fact, not a document -
  the pipe format that keeps memories portable also caps their size.
- Embedding-based recall quality bounds rehydration precision; the
  slot/revision protocol exists precisely so that a fuzzy recall can
  never resurrect a stale belief over a newer one.
