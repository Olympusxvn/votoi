# VOTOI - Prize Strategy (Tatum x Walrus: Total Recall)

Status: implementation push 2026-11-06. Targets: **Best Walrus Memory**
and **Best Use of Agent Payments** (= Mystery Bounty slot).

## 1. Scoring (official brief)

| Criterion | Weight | VOTOI lever |
|---|---|---|
| Walrus and Tatum Integration | 30% | Walrus canonical memory + Tatum gRPC primary + Data API screening/rate |
| Technical Quality | 30% | Clean TS (typecheck green), real Tatum Sui RPC integration, honest degradation |
| Creativity | 20% | Watchdog that learns habits, blocks risky sends, pays bills itself |
| Presentation | 20% | Docs + demo video + judge-verifiable claims |

Specials ($500 each): Best Walrus Memory, Best Tatum AI Builder App,
Best Use of Agent Payments ("using x402 or MPP, settled on Sui").

## 2. Prize mapping

**Best Walrus Memory.** Walrus is the canonical store, not a cache:
per-wallet namespaces, append-only `rev N` revisions, durable writes
(pending intents + idempotency keys), wipe-cache rehydrate proof, blob id
on every fact, chat citations, payment-rule memory loop, budget-risk
learning, revision history in UI, explorer links, upstream MemWal issues
filed (#1047-#1066 series).

**Best Use of Agent Payments.** Native Sui allowances (the x402/MPP
primitive on Sui): one atomic PTB per spend, spender-paid gas, 50 USD
auto-pay cap (code + DB CHECK + onchain), `awaiting_approval` +
human-signed release flow, real revoke PTB, Tatum pre-send screening,
autonomous bill pay, settled proofs below.

**Best Tatum AI Builder App.** Scaffold + early modules generated in AI
Builder (`docs/ai-builder-prompts.md`); every mock route replaced with
real services - no demo value is faked.

## 3. What this push added (P0/P1/P2)

P0 - survive judging day:
- `src/config/chainTransport.ts`: Tatum native gRPC primary (TLS +
  x-api-key metadata), Tatum JSON-RPC kept for recovery, public Sui
  gRPC + GraphQL fallback. Failover inside one call; one transport per
  spend; 429-aware retries (execute retries ONLY explicit 429s).
- MPP split proof settled onchain (see proof log).
- Precision widened to numeric(14,4) so sub-cent micro-payments record
  exactly (migration 0003).

P1 - agent behavior:
- Payment-to-memory loop (`paymentMemory.ts`): every settle/approval
  updates the `agent autopay` Walrus fact.
- Autonomous bills (`billPay.ts` + `scheduled_bills` + migration 0002):
  due bills settle themselves under the same guards as chat pay.
- Budget-risk learning (`synthesizeBudgetRisk`): weekly momentum writes
  `budget_risk` facts.
- Dream interval + `POST /api/dream/run`: compaction + OCR drain +
  bills run on schedule (COMPACTION_INTERVAL_MS, BILLPAY_AUTO_RUN).
- Human release flow: `approve-build` (unsigned funder PTB + fee
  estimate) and `approve-confirm` (onchain verify, then settle).
- Real revoke: `0x2::allowance::revoke` verified live, unsigned PTB
  for the funder wallet (replaces the 501).

P2 - depth:
- Receipt blob vault (`receiptVault.ts`): raw files to Walrus blobs,
  blob id on the receipt status, ledger link row.
- Tatum Data APIs (`tatumData.ts`): rate candidates (documented route
  first - this key 401s, CoinGecko fallback works) + pre-send address
  screening that blocks flagged recipients.
- UI: transport badge, dream status, namespace + MemWalAccount link,
  blob explorer links, per-fact revision history, payment
  standard/transport badges, approve UX, bills panel, receipt vault
  link.

## 4. Live proof log

| Proof | Evidence | Date | Cost |
|---|---|---|---|
| Chat pay 0.01 USD (x402, single) | digest `BDFfAHCMFFNnk5ERmBxqndZvin7NTTXXxPHJgUsFudrh` ([suiscan](https://suiscan.xyz/mainnet/tx/BDFfAHCMFFNnk5ERmBxqndZvin7NTTXXxPHJgUsFudrh)) | 2026-10-21 | ~$0.01 + gas |
| MPP split 0.003 USD (2 recipients, 1 PTB, via tatum-grpc) | digest `7V3xpKNHN7eikyPe8N1LbQfLEhSXYgyx92ZhipYJebJC` ([suiscan](https://suiscan.xyz/mainnet/tx/7V3xpKNHN7eikyPe8N1LbQfLEhSXYgyx92ZhipYJebJC)) + `scripts/settle-split-results.json` | 2026-11-06 | $0.003 + $0.0026 gas |
| Production allowance | `0x7a8d2e5abf179e66966125acb5796ea3b9649ddd949e8a63200a88c88cae1993` ("VOTOI phase2 allowance", cap 0.02 SUI) | 2026-10-21 | - |
| 12 facts / 12 Walrus blobs | `GET /api/health`, wipe-cache 12/12 | 2026-11-04 | - |

## 5. Demo beats (update the video only where marked)

1. Chat expense + grounded answer with citations.
2. Memory panel: facts, blob links, revision history, dream status.
3. Wipe cache: 12/12 restored from Walrus.
4. Payments: allowance card, settled rows (0.01 single + 0.003 MPP
   split), over-cap amber card + approve flow, revoke unsigned bytes.
   RE-RECORD if the split proof landed after the current cut.
5. Receipt upload: queued, vault blob id appears, honest OCR wait.
6. Bills (new): create a micro-bill, run due now, settlement row +
   Walrus payment fact update.

## 6. Risks and mitigations

- Tatum gRPC free-plan 429s: retries with backoff on build/simulate,
  execute retries explicit 429s only, public fallback keeps reads and
  (if needed) writes alive. Avoid demoing two spends back-to-back.
- Funder balance (~$0.005): covers the proofs above; top up the agent
  wallet before any new onchain demo beyond them.
- MemWal relayer outages: chat reads cache, writes persist as intents
  and recover next pass; UI labels degraded mode.
- Revoke/approve need the funder wallet: judges see unsigned bytes +
  copy, not a fake success.
- Receipt OCR vision provider still outstanding: vault + queue are
  real, text extraction is not claimed.

## 7. Budget log

- MPP split proof: $0.003 payment + $0.0026 gas (one tx, digest 7V3xpKNHN7eikyPe8N1LbQfLEhSXYgyx92ZhipYJebJC). Funder left ~$0.0022, spender ~$0.0068.
- Funder remaining after proofs: re-check `suix_getBalance` before
  any new spend; hard script cap stays 5.5M MIST per proof run.
- Total onchain demo spend to date: under $0.10.

## 8. Submission checklist

- [x] Public repo (no secrets; `.env` gitignored; secret scan clean)
- [x] Demo runs via AI Builder dashboard
- [x] Demo video recorded (splice beat 4/6 if proofs are newer)
- [x] Submission form filed (update proof links if changed)
- [x] Walrus usage blurb + honest reflection in form drafts
- [ ] Re-verify `/api/health` numbers on recording day
- [ ] Rotate keys after Nov 10 (delegate key doubles as spender)

## 9. Known limitations (kept honest)

- Legacy sponsored-split path is Tatum-JSON-only and unused by the
  server; the allowance path is the production one.
- `listRecentTransactions` has no fallback mapping (unused by routes).
- Tatum rate endpoint 401s with this key (no Data scope); CoinGecko
  serves pricing until a scoped key exists.
- Old digests prune from fullnodes (Oct 21 tx needs an indexer link,
  not an RPC re-check).

## 10. Route inventory (new since audit)

`GET /api/facts/history`, `GET/POST /api/bills`, `POST /api/bills/run`,
`POST /api/dream/run`, `POST /api/payments/approve-build`,
`POST /api/payments/approve-confirm`. Changed: `/api/health`,
`/api/status`, `/api/payments`, `/api/allowance/revoke`,
`/api/receipts*` (vault fields).
