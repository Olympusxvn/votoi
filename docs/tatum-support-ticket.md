# Tatum support ticket (paste-ready) - Sui gateway broken for this project key

> Prepared 2026-10-24. Supersedes the earlier draft (queued 2026-10-24 06:51 UTC)
> with the per-account-gateway finding from farm batch 2 (2026-10-24 07:30 UTC).
> Updated 2026-11-07: the JSON-RPC gateway is still 404 (re-verified 4 and
> 6 Nov); the same key works on the Tatum Sui gRPC gateway and the pay flow
> now runs on gRPC, so this ticket is a bug report on the JSON-RPC interface,
> not a blocker for our demo. Full evidence lives in
> `docs/submission-feedback.md`; per-call logs in
> `scripts/farm-api-results.jsonl`.
>
> RESOLVED 2026-11-07: I reported the JSON-RPC 404 to Tatum; Tatum answered
> to switch to the gRPC endpoint, confirming the JSON-RPC interface is retired
> (Sui phased out legacy JSON-RPC on Mainnet and Testnet during summer 2026,
> July per Tatum). No restore needed; VOTOI already runs on gRPC. Closed as
> answered.

---

**Subject:** Sui Mainnet gateway broken for project key - 404 on shared gateway, -16500 "Invalid response from upstream" on account gateway

**Account/project:** plan FREE, project with API key ending in the key used since 21 Oct 2026 (gateway URL `olympusxvn-df8e9414.gateway.tatum.io`, gateway id `df8e9414-c9a3-4717-962e-19fda78ef242` per `/v4/manage/gateway`)

**Timeline:**
- 21 Oct 2026: 71 Sui Mainnet gateway calls, all HTTP 200 (allowance issuance, spend, tx confirmation - all working).
- 22-23 Oct 2026: no Sui gateway calls from us.
- 24 Oct 2026: every Sui JSON-RPC call fails, in two different ways depending on the URL.
- 4 Nov 2026: one sui_getChainIdentifier call, still HTTP 404.
- 6 Nov 2026: one sui_getChainIdentifier call, still HTTP 404. Same day, the same key worked on the Tatum Sui gRPC gateway (GetServiceInfo in 762 ms) and our 0.003 USD MPP split settled through it (digest 7V3xpKNHN7eikyPe8N1LbQfLEhSXYgyx92ZhipYJebJC).

**Failure mode 1 - shared gateway not routed (HTTP 404):**
POST `https://sui-mainnet.gateway.tatum.io` with the project key returns HTTP 404 `{"statusCode":404,"message":"Not Found"}` for every method tested (`sui_getChainIdentifier`, `sui_getLatestCheckpointSequenceNumber`, `suix_getBalance`, `sui_getObject`, `suix_getOwnedObjects`, `sui_getTransactionBlock`, `sui_getNormalizedMoveFunction`, `sui_getTotalTransactionBlocks`, `suix_getReferenceGasPrice`, `sui_getProtocolConfig`, `suix_getLatestSuiSystemState`, `suix_getAllBalances`) - 1200 attempts, uniform signature. A bogus key returns 401, so the request shape, URL and methods are correct and match docs.tatum.io; the route is missing for this key.
Your dashboard Access Logs confirm it is an edge-routing problem: on 24 Oct 13:27-13:33 (UTC+7) the 404 rows return in ~1 ms with Network, Blockchain, Interface ID and Gateway ID all EMPTY and "No error log was recorded" - nothing is forwarded. Example trace ID: `3186381babd4ced97193205f4a6113e1`. (Access Logs does not record the JSON-RPC method name, rows show only POST /.)

**Failure mode 2 - account gateway routes but upstream is broken (JSON-RPC -16500):**
POST `https://olympusxvn-df8e9414.gateway.tatum.io/` (the per-account URL from `/v4/manage/gateway`) with the same key returns HTTP 200, but the JSON-RPC body is error code **-16500 "Invalid response from upstream"** for `sui_getChainIdentifier`, `suix_getBalance`, and `sui_getLatestCheckpointSequenceNumber`. So the Sui interface itself looks broken server-side, not just unmapped for this key.

**Impact:** our hackathon demo (Walrus x Tatum Total Recall, submission 10 Nov) no longer blocks on the JSON-RPC gateway: chain traffic moved to the Tatum native gRPC gateway (primary) with a public fallback, and the onchain pay flow dry-runs and settles through it (verified 6 Nov). The JSON-RPC interface itself is still broken, which is what this ticket reports.

**Ask:** please restore the Sui mainnet interface mapping for this key (or fix the upstream behind the account gateway) and confirm whether Sui gateway access requires a plan change on our side - the dashboard greys "RPC Calls" behind Upgrade, which made the 404 look like a plan gate, but the -16500 on the account gateway points to a genuine upstream outage. If the JSON-RPC interface is being retired in favor of gRPC, please say so and point the Sui docs at the gRPC migration path instead of the JSON-RPC method list.

**Evidence we can share:** Access Logs rows above, per-call logs of 1880 calls (1340 gateway 404s, 540 v4 200s, zero 429s - all paced read-only calls, no writes), the three -16500 response bodies, plus the Nov 6 gRPC probe (GetServiceInfo, 762 ms) and the settled MPP split digest above.
