# VOTOI — Submission form drafts (Tatum x Walrus: Total Recall)

Prepared 2026-10-24 from verified evidence only. Paste into the submission
form (tatum.io/hackathon/total-recall). Fields marked * are required.
Still outstanding at draft time: demo video (2-3 min, to record), public
repo link (main repo push happens near the deadline per the no-early-push
rule; the Builder scaffold repo github.com/Olympusxvn/votoi is already
public), blog post (optional; skeleton = docs/walrus-memory.md).

---

## 03 Project — Project description *

VOTOI is an expense watchdog agent with long-term memory. It chats with
the user about spending, learns facts (merchant habits, budget risks,
payment rules, preferences) and stores them as canonical memory in Walrus
Memory on Sui Mainnet, while a Neon Postgres cache serves fast reads.
When memory is missing, the agent rehydrates the whole cache from Walrus,
so wiping the database loses nothing — the demo proves this live.
For payments, VOTOI uses native Sui allowances (sui::allowance): the user
issues an onchain allowance naming the agent as spender with lifetime and
time limits, and the agent pays approved expense splits from the user's
balance in one atomic transaction, never more than 50 USD per transaction,
with the funder able to revoke at any time. All chain access goes through
the Tatum Sui gateway, and transaction confirmation uses RPC status
checks because Tatum Notifications does not support Sui. The demo app
(chat + memory panel + payments panel) was built with the Tatum AI
Builder and wired to these real services.

---

## 04 Feedback — How was your experience building with Walrus? *

Overall strong, with two rough edges we engineered around. The MemWal SDK
made the core loop easy: remember() with async jobs, semantic recall that
ranked the right fact first in our tests, and a per-user namespace model
that fits a watchdog agent. We shipped 12+ facts to Walrus Memory Mainnet
and verified cold rehydration end to end. Pain points: (1) the relayer's
embedding backend went down for hours on 22 Oct 2026 (writes failed with
"Embedding API error 401 User not found", recall returned 500), which
forced us to build a durable write pipeline with persisted intents,
deterministic idempotency keys, and recovery on every pass; (2) the SDK
is append-only with no update, delete, or getMemories, and restore()
stamps restored memories with the restore time as created_at, so we order
mutations with an embedded revision number instead. Smaller wishes:
remember() blocks against serverless time budgets, and accepted jobs do
not expose a durable receipt for later recovery. We filed these upstream
as MystenLabs/walrus-memory issues and the workarounds are documented in
our repo.

---

## 04 Feedback — How was your experience building with the Tatum AI Builder? *

We built with it throughout: it generated our Sui RPC integration
modules (agentPayments, webhook handler) and later the full demo app
(chat, memory panel, payments panel) from a single detailed prompt, and
GitHub Sync kept the generated code flowing into our repo reliably. The
scaffold quality is good and the Tatum design tokens made the UI look
polished fast. Two things to improve: (1) the generated backend was a
mock — seed facts with invented blob ids, fake transaction digests, and
in-memory state — so every route had to be rewritten against our real
services before the demo was honest; generated code should be flagged
when it invents chain data instead of calling it; (2) the free prompt
budget ran out fast (our last free prompt went to the full app), and
Builder Code/Publish still show as "Soon", leaving GitHub Sync as the
only export path. Clearer labeling of mock vs live data and a visible
remaining-prompt counter would help.

---

## 04 Feedback — One bug or friction point with Walrus Memory (OPTIONAL)

On 22 Oct 2026 the MemWal relayer's embedding backend failed for hours:
every write failed with "Embedding API error 401 User not found" and
recall returned 500, while our chat kept working only because it reads
the Postgres cache. Same failure class as upstream issue #1047
(relayer "encryption backend unavailable"). A public relayer status page
or a degraded-mode signal in the SDK (so apps can show "memory writes
delayed" instead of failing) would make this much easier to ride out.
