RULE.md — VOTOI (SYSTEM RULES & BOUNDARIES)


🛡️ 1. Core Architectural Constraints

All code components generated or executed by Muse AI for the VOTOI framework must strictly adhere to the following infrastructure boundaries to guarantee compliance with the hackathon judging standards [14.15]:
• Boundary 1: Sub-2-Second Chat Latency Restriction
The primary user interaction thread (POST /api/v1/chat) must never exceed a 2.0-second execution window [14.15]. Any heavy transactional decoding, external API queries (with the exception of fast simulations), or document parsing must be offloaded to isolated asynchronous background workers (src/workers/asyncOcr.ts) via temporary database status hooks.
• Boundary 2: Long-Term Memory Decoupling
The local cache database (Neon Postgres) is explicitly categorized as volatile storage. Walrus Memory Mainnet is the absolute Canonical Source of Truth [14.14, 14.15]. No conversational context or behavioral rule updates are verified as "learned" until committed to Walrus Mainnet via memwal.remember() [14.14, 14.15].
• Boundary 3: Explicit Serialization Standard
To eliminate formatting anomalies across diverse platforms (WebUI & Telegram Bot), memory string serialization must strictly reject all em-dashes (—) [14.15]. The system must enforce vertical pipeline delimiters (|) exclusively inside the context packet format:
[watchdog:fact_type] subject | pattern | rule [14.15]


💱 2. Data & Financial Constraints

To ensure systematic uniformity throughout all financial aggregation tasks, the codebase must enforce these structural rules:
• Rule 1: Currency Standardization
All internal calculations, ledger records inside Postgres (transactions, media_uploads), and serialized text blocks stored on Walrus must be dynamically parsed, evaluated, and presented in United States Dollars (USD).
• Rule 2: Absolute Protection of Secrets
Under no circumstances are user private keys, cryptographic wallet seed phrases, or key-share configurations allowed to be cached in plain text inside the Postgres tier or transmitted across public API channels. All Web3 authorization structures must leverage secure client-side signatures or sandboxed Tatum KMS modules.


🔌 3. Sponsor SDK Guardrails (Tatum & Walrus)

• Guardrail 1: Rate-Limit Cryptographic Defense
To protect the VOTOI backend from HTTP 429 Over Rate Limit errors during highly volatile network activity, direct block polling is strictly prohibited. All onchain transaction monitoring must route through Tatum's streaming webhook engine (Start monitoring of the address).
• Guardrail 2: Webhook Integrity Enforcement
The incoming Tatum webhook endpoint /api/v1/tatum-webhook must drop any transaction updates that fail the x-payload-hash HMAC-SHA256 signature test transaction check.
• Guardrail 3: Memory Mutation Integrity (Vòng lặp học sâu)
To satisfy the Best Walrus Memory Prize requirements, the agent must avoid raw memory data accumulation [14.14, 14.15]. When updating habits, it must always check for old facts using memwal.getMemories(), run a compaction delta check, and push updated version increments to avoid data bloat [14.14, 14.15].


🎬 4. Demo Validation Boundaries (Rehydration Flow)

• Rule: The system must protect the state rehydration module against recursive initialization loops. If a local Postgres database cache tables lookup returns completely void (Cache Miss), the application router must halt standard prompt evaluation, query the structural indices via memwal.getMemories(), populate the Neon Postgres cache tables, and only then re-allow the LLM agentic workflow loop to execute [14.14, 14.15].


Instructions for Muse AI Core Execution:

"Read and enforce this RULE.md manifest as an active runtime policy validator. Reject any code transformations that introduce em-dashes into storage layers, enforce USD as the global financial type, and ensure all network integrations pass through the approved Tatum and Walrus pipeline specifications." [14.15]

*   **Rule 3: x402 / MPP Operational Enclosure**  
    Agent automated payments utilizing the x402 protocol or MPP frameworks must operate under strict, isolated execution sandboxes. The maximum single transactional asset value must be capped at **50.00 USD** equivalent on the Sui network. Any transaction block parsing above this specific ceiling must fail automatically and fall back to requesting an explicit manual human-in-the-loop signature window via the WebUI.
