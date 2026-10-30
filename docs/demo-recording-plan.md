# VOTOI — Demo recording plan (2-3 min video for submission)

Target: one continuous screen recording, 1080p, with voiceover or captions.
App: `npm run dev` in ~/workspace/votoi (server on http://localhost:3000).
The frontend already has a Demo Mode walkthrough bar (4 beats); follow it.

## Prep (before pressing record)
- Start the app, confirm: facts panel shows 12 facts with real Walrus blob
  ids; chat answers a test question grounded in facts; allowance build
  returns an unsigned tx; payments panel shows the settled 0.01 USD row.
- Close everything that could leak secrets: no terminal with .env, no
  editor with keys, no dashboard tabs. Wallet addresses on screen are
  public identifiers and fine to show.
- Do a dry wipe-cache run first so the recorded one restores 12/12 cleanly
  (verified live 2026-10-24; re-verify on recording day).

## Script (aim ~2:50 total)
- 0:00-0:20 Intro: "VOTOI is an expense watchdog agent with long-term
  memory. It learns your spending habits, stores them in Walrus Memory on
  Sui Mainnet, and pays approved splits through onchain allowances."
  Show the hero proof badges.
- Beat 1, 0:20-0:50 (chat): send a live expense message in chat
  ("I spent 120k VND on GrabFood"). Show the agent's reply grounded in
  existing facts.
- Beat 2, 0:50-1:30 (memory): open the memory panel, filter to the
  merchant fact (GrabFood rev 2), show its real Walrus blob id. Say new
  expenses compact to Walrus the same way (compaction runs async; do not
  claim the just-typed message already has a blob unless it does).
- Beat 3, 1:30-2:10 (wipe-cache): press wipe-cache, show the cache
  empty, then all 12 facts restored from Walrus. This is the strongest
  beat — linger on the restored count.
- Beat 4, 2:10-2:50 (payments, HONEST version): press allowance build
  and show the real unsigned transaction; open the payments panel and
  show the settled 0.01 USD payment from 2026-10-21 (label its date on
  screen or in voiceover). Say plainly: "Live pay execution currently
  waits on a Tatum gateway outage; the settlement above is the same
  allowance flow executed onchain on Oct 21." Never show a fake
  success, never claim a live payment that did not execute.
- 2:50-3:00 Outro: repo link + "try it" line.

## If the gateway recovers before Nov 10
Re-record Beat 4 only, with a live "pay 0.01 USD" chat command executing
onchain, and splice it in. Do not re-record the whole video.

## Do NOT show or claim
- No fake digests, blob ids, or "revoked" states (the app refuses to fake
  these by design: revoke is 501, receipts queue without a blob id).
- No live-pay claim while the gateway returns 404 / -16500.
- No .env, private keys, or Tatum dashboard key values on screen.
