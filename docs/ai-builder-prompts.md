# AI Builder prompts for VOTOI (ai.tatum.io)

Paste one prompt at a time into ai.tatum.io. Review the generated code, then it gets integrated into this repo (src/services/, src/api/). Never paste real API keys - the prompts only reference environment variable names.

Context shared by all prompts: TypeScript (strict), Node 20, Sui mainnet reached ONLY through the Tatum gateway RPC at https://sui-mainnet.gateway.tatum.io with header `x-api-key: process.env.TATUM_API_KEY`. Tatum nodes reject `unsafe_*` RPC methods, so transactions are built client-side with @mysten/sui and only transported/signed through standard RPC methods.

Design update 2026-10-21 (organizer-shared sources: docs.sui.io/onchain-finance/allowances + x402.org): agent payments use native Sui allowances (sui::allowance), NOT an escrow. The user (funder) issues a Direct allowance naming the agent (spender, VOTOI_AGENT_SUI_ADDRESS) with onchain limits; the agent spends from the user's address balance inside those limits and pays its own gas; the funder can revoke at any time via AllowanceCap. Sui's docs describe allowances as the mechanism that lets agentic wallets pay through x402 or MPP, which is the settlement story for the Best Use of Agent Payments prize. Requires @mysten/sui >= 2.31 for allowance support in the Transaction builder.

---

## Prompt 1 - agentPayments: allowance-based agent spending + multi-party split on Sui (Step 3, core module)

Build a TypeScript module `agentPayments.ts` for a Sui mainnet expense-splitting agent. All blockchain access goes through the Tatum Sui gateway RPC endpoint https://sui-mainnet.gateway.tatum.io using the `x-api-key` header read from process.env.TATUM_API_KEY. Use @mysten/sui version 2.31 or later (required for allowance support in the Transaction builder) pointed at that gateway URL.

Background: Sui allowances (module `sui::allowance`) let a funder authorize one spender to withdraw a coin type from the funder's address balance within onchain limits (lifetime cap, rate limit, expiration). The user is the funder; the agent address from process.env.VOTOI_AGENT_SUI_ADDRESS is the spender. There is no escrow and no pre-funding: funds stay in the user's balance until a spend succeeds, and the spender pays gas on spending transactions.

Requirements:
1. Export `buildIssueAllowanceTx(params)` with params = { funderAddress: string, spenderAddress: string, name: string, lifetimeCapUsd?: number, monthlyLimitUsd?: number, expirationDays: number, usdToCoinRate: number, coinType: string }. It returns an UNSIGNED Transaction (the funder signs it with their own wallet) that calls `0x2::allowance::new` with the Balance type argument for coinType (for example `0x2::balance::Balance<0x2::sui::SUI>`), converting USD limits to the coin's smallest unit, building the rate limit with `0x2::allowance::monthly_rate_limit` when monthlyLimitUsd is given and `0x1::option::none` for absent options. At least one of lifetimeCapUsd / monthlyLimitUsd must be set - throw a typed error otherwise.
2. Export `buildSplitPaymentFromAllowance(params)` with params = { spenderAddress: string, funderAddress: string, allowanceId: string, splits: Array<{ recipient: string, amountUsd: number }>, usdToCoinRate: number, coinType: string }. It builds ONE atomic Transaction whose sender is the spender: withdraw the total through the allowance using tx.balance({ allowance: { objectId: allowanceId, funder: funderAddress }, type: coinType, balance: totalInSmallestUnit }), convert the returned balance to a coin with `0x2::coin::from_balance`, split it with SplitCoins, and TransferObjects so each recipient receives exactly their split in the same transaction.
3. Hard rule enforced in code before building: if the total of all splits exceeds 50.00 USD, throw an error named `HumanApprovalRequired`. The onchain allowance limits are a second, independent enforcement layer - keep the in-code check as well.
4. Export `dryRunPayment(tx)` that serializes the transaction and calls `sui_dryRunTransactionBlock` through the Tatum gateway, returning parsed effects, gas estimate and balance changes.
5. Export `executePayment(tx, spenderKeypair)` that signs as the spender and submits via `sui_executeTransactionBlock` through the gateway, returning the transaction digest.
6. Export `buildRevokeAllowanceTx(params)` with params = { allowanceCapId: string, allowanceId: string } returning an unsigned Transaction the funder signs to revoke the allowance immediately.
7. Validate all Sui addresses with isValidSuiAddress, throw typed errors, full TypeScript types for all inputs and outputs, no `any`. Do NOT use any `unsafe_*` RPC method - the gateway rejects them.

## Prompt 2 - Tatum webhook handler for Sui transaction confirmation (Step 5)

Build a TypeScript webhook handler `webhook.ts` (framework-agnostic, exports `handleTatumWebhook(req)` returning { status, body }) for Tatum address-event notifications on Sui mainnet.

Requirements:
1. Verify the webhook signature before anything else: Tatum sends an HMAC-SHA512 hash of the raw request body in the `x-payload-hash` header, keyed with process.env.TATUM_WEBHOOK_SECRET. Compare with crypto.timingSafeEqual; reject with HTTP 401 on mismatch. The raw body must be read as a string before JSON parsing.
2. Parse the payload for the Sui transaction digest and event data. Deduplicate: the handler receives a `findTransactionByDigest(digest)` and `markTransactionConfirmed(digest, blockHeight)` callback in its config object (dependency injection, do not import a database directly). If the digest was already processed, return HTTP 200 immediately without re-processing.
3. On a new confirmed transaction, call markTransactionConfirmed and return HTTP 200 with a JSON summary { digest, confirmed: true }.
4. Handle malformed payloads with HTTP 400 and a typed error body. Never log the webhook secret or the raw signature.
5. Full TypeScript types for the payload (define a TatumSuiWebhookPayload interface with optional fields), no `any`.

## Prompt 3 - Sui RPC read client via Tatum gateway (Step 3, support module)

Build a small TypeScript module `suiReads.ts`: a read-only Sui client using SuiClient from @mysten/sui pointed at https://sui-mainnet.gateway.tatum.io with the `x-api-key` header from process.env.TATUM_API_KEY injected via a custom fetch or request hook.

Export typed functions:
1. `getUsdBalance(address, coinType)` - returns the balance converted to a USD number using a rate parameter.
2. `getRecentTransactions(address, limit)` - uses suix_queryTransactionBlocks filtered by FromAddress/ToAddress, newest first, returning digest, timestamp and effects status.
3. `getTransactionStatus(digest)` - uses sui_getTransactionBlock, returns 'confirmed' | 'pending' | 'failed' based on effects.
Retry transient gateway errors (HTTP 429 and 5xx) up to 3 times with exponential backoff. Full TypeScript types, no `any`.

## Prompt 4 - VOTOI web app: chat + Walrus memory + allowance payments UI (Phase 3, FINAL free prompt, authorized by user 2026-10-24)

Build the complete VOTOI web app in this project (React + Vite + Express scaffold). VOTOI is an expense watchdog agent: it chats with the user about spending, remembers learned facts in Walrus Memory on Sui Mainnet (long-term memory), and can pay approved expense splits onchain through a Sui allowance, with every blockchain call routed through the Tatum Sui gateway. All money is displayed in USD. The UI language is English.

Layout: dark theme (near-black background, one violet accent, clean sans-serif, generous spacing, rounded cards), responsive, three panels on desktop and stacked on mobile:

1. Chat panel (main, widest): conversation with the watchdog agent. Message input with send button, Enter to send, visible typing/loading state, auto-scroll to the newest message. Five suggestion chips above the input: "I spent 12.50 USD on GrabFood", "What do you know about my coffee habit?", "Pay 0.01 USD to the agent wallet", "What is my spending profile?", "Any budget risks this month?". Sends POST /api/chat with JSON { userId, message } and renders the `reply` string from the JSON response. userId is a wallet address kept in a settings field at the top of the page, defaulting to 0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804.

2. Memory panel ("What VOTOI remembers"): list of learned facts from GET /api/facts?userId=<address>. Each fact card shows: fact type badge (merchant_habit, budget_risk, payment_rule, preference), subject, pattern text, rule text, revision number, and its Walrus blob id shortened to the first 10 characters with a copy button. A highlighted card on top shows the "spending profile" fact when present. Include a demo button "Wipe cache and rehydrate from Walrus" that calls POST /api/test/wipe-cache with { userId } and then reloads the facts list, with a confirm dialog explaining this proves the memory lives on Walrus, not in the app database.

3. Payments panel ("Agent payments"): allowance status card from GET /api/status?userId=<address> showing allowance id (shortened), lifetime cap, amount already spent, expiration date, and the agent wallet balance in USD. Below it, a list of recent agent payments (recipient, USD amount, status, timestamp) where each confirmed payment links its transaction digest to https://suiscan.xyz/mainnet/tx/<digest>. A note under the card states the safety rule in plain words: "The agent can only spend inside the onchain allowance limits, and never more than 50.00 USD in one transaction. Larger amounts require your approval."

Also build the three Express routes in this project as thin, typed handlers with the exact contracts above: POST /api/chat forwards { userId, message } to the agent service and returns { reply }; GET /api/facts and GET /api/status read from environment-configured backends and return JSON arrays/objects matching the shapes described; POST /api/test/wipe-cache accepts { userId } and returns { wiped: true }. Use placeholder service functions with clear TODO markers where the real agent, database and Sui services plug in, reading all secrets and URLs from process.env only (TATUM_API_KEY, DATABASE_URL). Full TypeScript types, no `any`, loading and error states for every panel, and no emojis in the UI.

## Prompt 4 v2 - MAXIMAL (replaces v1 if not yet submitted; otherwise paste as the follow-up iteration prompt)

Context: VOTOI is an expense watchdog agent built for the Walrus x Tatum Total Recall hackathon, Track 2, competing for Best Walrus Memory, Best Tatum AI Builder App, and Best Use of Agent Payments. This app is the submission demo, so every feature below must work end to end in the preview, not as a mock. The project already contains agentPayments.ts (buildIssueAllowanceTx, buildSplitPaymentFromAllowance, spendFromAllowance, dryRunPayment, executePayment, buildRevokeAllowanceTx) and webhook.ts: REUSE them, do not regenerate them. The UI language is English, all money is shown in USD, no emojis anywhere.

Build the complete VOTOI web app (React + Vite + Express scaffold) with a dark theme (near-black background, one violet accent, clean sans-serif, generous spacing, rounded cards), responsive (three panels on desktop, stacked on mobile), with loading skeletons, empty states, and error toasts on every panel. Never poll any blockchain endpoint on an interval; refresh data on user action or after a mutation only.

Sections, top to bottom:

1. Hero header (first thing a judge sees): product name VOTOI, one-line pitch "An expense watchdog that remembers everything and can pay within limits you set onchain", and three small proof badges: "Memory: Walrus Mainnet", "RPC: Tatum Sui Gateway", "Payments: Sui allowance (x402-style)". A settings row holds the user wallet address (default 0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804), editable, used as userId by every panel.

2. Chat panel (main, widest): conversation with the watchdog agent. Input with send button, Enter to send, typing indicator, auto-scroll, and six suggestion chips: "I spent 12.50 USD on GrabFood", "What do you know about my coffee habit?", "Pay 0.01 USD to the agent wallet", "What is my spending profile?", "Any budget risks this month?", "Show my recent agent payments". Sends POST /api/chat { userId, message } and renders the `reply` string. Add a receipt upload dropzone in this panel: user drops an image or PDF, it uploads and is queued for async OCR, and a small status line shows "Receipt received, processing in background" (the OCR worker fills the text later; do not block the chat on it).

3. Memory panel ("What VOTOI remembers"): GET /api/facts?userId=<address> returning [{ factType, subject, pattern, rule, revision, walrusBlobId }]. Each fact card shows a type badge (merchant_habit, budget_risk, payment_rule, preference), subject, pattern, rule, revision, and the Walrus blob id shortened to 10 characters with a copy button. A highlighted card on top shows the fact with subject "spending profile" when present. Include a demo button "Wipe cache and rehydrate from Walrus": confirm dialog explaining this proves memory lives on Walrus, not in the app database; it calls POST /api/test/wipe-cache { userId }, then reloads the facts list and shows a success toast with the number of facts restored. Include a small status line showing Walrus relayer health (healthy/degraded) from GET /api/status.

4. Payments panel ("Agent payments"): GET /api/status?userId=<address> returning { allowanceId, lifetimeCapUsd, spentUsd, expirationMs, agentBalanceUsd }. Show these in an allowance card, plus a "Revoke allowance" button that calls POST /api/allowance/revoke { userId, allowanceCapId } with a confirm dialog. Add an "Issue allowance" section: inputs for lifetime cap (USD) and expiration (days), a button "Build allowance transaction" that calls POST /api/allowance/build { userId, lifetimeCapUsd, expirationDays } and returns the unsigned transaction bytes plus a clear message that the funder signs it with their own Sui wallet (use the existing buildIssueAllowanceTx module; do not invent signing). Below, GET /api/payments?userId=<address> returning [{ recipient, amountUsd, status, digest, timestamp }] as a payment list; each confirmed payment links its digest to https://suiscan.xyz/mainnet/tx/<digest>. A note under the card states: "The agent can only spend inside the onchain allowance limits, and never more than 50.00 USD in one transaction. Larger amounts require your approval."

5. Demo mode: a toggle "Demo script" that walks a judge through the four demo beats in order, highlighting the relevant panel at each step: (1) chat an expense, (2) show the learned fact in Memory, (3) wipe cache and rehydrate from Walrus, (4) pay 0.01 USD through the allowance. Each step is a short sentence with a "Go" button that focuses the panel.

Backend: build the Express routes as thin typed handlers with these exact contracts: POST /api/chat -> { reply }; GET /api/facts -> array above; GET /api/status -> object above; GET /api/payments -> array above; POST /api/test/wipe-cache { userId } -> { wiped: true, factsRestored: number }; POST /api/allowance/build -> { unsignedTxBytes, note }; POST /api/allowance/revoke -> { revoked: true }; POST /api/receipts (multipart upload) -> { queued: true, blobId }. Where the real agent, database, and Sui services plug in, use clearly marked TODO service functions reading only process.env (TATUM_API_KEY, DATABASE_URL). Full TypeScript types, no `any`.

## Prompt 5 - Polish iteration: receipt results, approval display, budget-risk summary, demo beat 5 (frontend only, 2026-11-04)

Instruction first: just run the code. Do not output explanations in the chat window; put any notes as code comments or TODO markers only.

Context: this is a polish iteration on the existing VOTOI web app from Prompt 4 v2 (React + Vite + Express scaffold, dark theme, near-black background, one violet accent, English UI, all money in USD, no emojis anywhere). REUSE everything that already exists: the chat, memory, payments, allowance issue/revoke panels, the receipt dropzone, and the 4-beat demo script. Do NOT regenerate agentPayments.ts, webhook.ts, or suiReads.ts. Never poll any blockchain endpoint on an interval; refresh chain data on user action or after a mutation only.

Hard honesty rules (do not break these):
- Never claim a receipt has a Walrus blob id. The receipts backend returns blobId null for receipts; receipts are queued locally for OCR, they are not Walrus memory facts.
- Do not change the revoke contract. POST /api/allowance/revoke honestly returns 501 until the Move revoke entry point is verified live against the gateway. The Revoke button must keep calling that endpoint and must show the real error, never a fake success toast.

Build exactly these four things:

1. Receipt results. After POST /api/receipts returns { queued: true, receiptSha256 }, poll GET /api/receipts/:sha every 3 seconds (local backend status only, not a blockchain endpoint; stop after 60 seconds or on a terminal state) with contract { status: 'queued' | 'processing' | 'done' | 'failed', merchant?: string, amountUsd?: number, error?: string }. Show a spinner line while queued/processing; on done show a card "Receipt read: <merchant> — <amountUsd> USD" with a note that a fact will be learned from it (do not invent the fact text); on failed show an honest "Could not read this receipt" state with a retry upload button. Mark the backend handler with a clear TODO: wire it to the real async OCR worker row; until wired it may keep returning queued.

2. Approval display (display only, no new backend action). Payment items and chat replies may carry status 'needs_approval' when an amount exceeds the 50.00 USD single-transaction limit. Render an amber card: "Over the 50.00 USD single-transaction limit — needs your approval, not sent onchain." Do NOT add an approve/send button: no approval backend exists yet, so nothing may pretend to send it.

3. Budget-risk summary. At the top of the Memory panel, add a "This month's risks" card aggregating the facts with factType budget_risk: a count plus their subjects as a list. Empty state when there are none: "No budget risks recorded."

4. Demo beat 5. Extend the Demo script from 4 beats to 5, keeping beats 1-4 exactly as they are. Beat 5 is: "Upload a receipt and see the read result", focusing the chat panel dropzone, with Next/Restart navigation consistent with the existing beats.

Backend: add only thin, typed Express handlers with the exact contracts above and TODO markers where the real OCR service plugs in. Full TypeScript types, no `any`, loading, empty, and error states on every new element.

## Prompt 5 — Implemented 2026-11-04 by Muse (not AI Builder; Builder turns exhausted)

Implemented directly in src/server.ts + app/src/App.tsx, no Builder credit spent. Deviations from the prompt above, all honesty-driven:
- Receipt status is a local sidecar JSON file next to the uploaded file, NOT a media_uploads DB row: that table requires walrusBlobId NOT NULL and receipts have none (no Walrus upload for receipts yet). GET /api/receipts/:sha reads the sidecar; unknown sha → 404.
- The receipt record honestly stays "queued" until a vision provider fills OCR text (workers/asyncOcr.ts owns everything after text exists). Demo beat 5 therefore shows the live queue status, not a read result — nothing is faked.
- needs_approval was NOT display-only mock: the backend already recorded awaiting_approval rows and returned action payment_needs_approval, but src/server.ts dropped the action. The fix plumbs it through; the amber card has no approve button because no approval backend exists.
- Revoke untouched: still an honest 501, and the revoke dialog now says so.

## Prompt 6 items — Implemented 2026-11-04 by Muse (borrowed from RecallSpend review, local only, NOT pushed)

1. GET /api/health: { ok, factsCached, walrusBlobsCached, dbStatus, relayerStatus, tatumGateway note }. Counts come from the local cache and are labeled as such; the endpoint never probes the Tatum gateway (no credit burn per call). Live check 2026-11-04: factsCached 12, walrusBlobsCached 12, relayer healthy.
2. Chat citations: deterministic answer paths (question + expense-with-rule) now return citations [{ subject, blobId }] for exactly the facts used; the LLM path returns none (sources not attributable). Server and UI plumb them through; UI renders "Sources (Walrus)" with short blob + copy. Live check 2026-11-04: "coffee habit" question returned 3 citations matching the quoted facts.
3. Gateway incident re-verified 2026-11-04 with ONE sui_getChainIdentifier call: still HTTP 404 on the generic gateway URL. Health note updated to that date.
