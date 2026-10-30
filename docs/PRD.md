PRD.md — VOTOI (EXPENSE WATCHDOG AGENT)


🎯 1. Product Overview & Objectives


1.1 Purpose

VOTOI (Expense Watchdog Agent) is a smart, multimodal financial monitoring assistant designed to solve the disconnection between real-world offline spending behaviors and Web3 onchain activities [14.14, 14.15]. By utilizing Walrus Memory Mainnet and Tatum SDK/Data APIs, VOTOI tracks, learns, and automatically acts to secure and optimize user assets [14.14, 14.15].

1.2 Target Audience

• Web3 power users managing active personal wallets on the Sui Network.
• Individuals seeking automated, zero-effort expense tracking combining real-world receipts with decentralized financial logs.

1.3 Key Performance Indicators (KPIs)

• Chat Response Latency: < 2.0 seconds for standard queries via the 2-Tier Hybrid Storage layout [14.15].
• Real-time Synchronization Lag: < 1.0 second from Tatum Webhook execution to Agent UI refresh.
• Memory Compliance: 100% of serialized long-term memories stored on Walrus Mainnet with zero em-dashes (—) [14.15].


🎛️ 2. User Personas & Core Workflows


2.1 User Persona: The Active Web3 Spender

• Behavior: Uses their Sui wallet for daily decentralized transactions while spending standard fiat (USD) at retail shops, coffee hubs, and monthly digital subscriptions.
• Pain Point: Forgets to log microtransactions, resulting in regular budget overruns. Annoyed by complex ledger applications and high chatbot response latencies.

2.2 Core User Workflows

1. Multimodal Receipt Intake: User snaps a photo of a physical bill -> Agent processes and logs data in the background -> Budget thresholds are updated seamlessly.
2. Cross-Session Rehydration: User signs in from a fresh Telegram client -> Agent immediately recovers historical memory context directly from Walrus Mainnet [14.14, 14.15].


🚀 3. Functional Requirements & Feature Specification


FR-01: Cross-Session Fact Mutation & Versioning (Walrus Priority)

• Description: The system must condense repetitive transactional logs into standalone, evolving behavioral state strings (Clean Facts) rather than creating endless log arrays [14.14, 14.15].
• Technical Flow:
	1. Agent retrieves existing context records via memwal.getMemories() [14.14, 14.15].
	2. LLM engine aggregates historical habits with the newest transaction telemetry.
	3. Old fact metadata status updates to "mutated", incrementing the internal version flag.
	4. Overwrites the target memory slot on Walrus Mainnet via memwal.remember() [14.14, 14.15].
• Acceptance Criteria: Serialized strings must follow the [watchdog:fact_type] subject | pattern | rule format, replacing all em-dashes (—) with vertical pipelines (|).

FR-02: Sui Native Automated Payment & Escrow Adapter (Tatum Priority)

• Description: An agentic, secure escrow sub-layer built using Tatum AI Builder to execute automated microtransactions for cleared, predefined liabilities [14.14, 14.15].
• Technical Flow:
	1. User deposits a strict operational budget allocation into the app-controlled escrow contract.
	2. When an official invoice/bill is parsed, VOTOI matches it against valid Walrus Memory criteria.
	3. If approved, the agent fires a backend transaction request using the Tatum Sui RPC layer.
	4. Settles the payment automatically without triggering manual wallet extension approval prompts.
• Acceptance Criteria: Transfers must automatically halt if the requested amount exceeds the active balance limits stored within the long-term memory constraints.

### FR-02: Bounded Agent Payments via x402 / MPP Protocols
*   **Description:** The agent must expose an interface to deploy a secure execution sub-account governed by the x402 asset-streaming rule or Multi-Party Payment (MPP) architecture, settling transactions deterministically on Sui.
*   **Technical Flow:**
    1. User authorizes a maximum daily/weekly "Spending Gas Limit" (denominated in USD) to the VOTOI Agent Account.
    2. Upon processing automated bills (e.g., cloud bills, recurring subscriptions) or executing complex grouped payments (Multi-Party splits), the agent structures an x402-compliant payload transaction.
    3. The transaction bypasses manual end-user verification and settles instantly on the Sui Mainnet.
*   **Acceptance Criteria:** Every x402/MPP execution must emit an onchain ledger event, verify gas-sponsored boundaries, and immediately store the immutable record as a compacted Fact string inside Walrus Memory.


FR-03: Real-Time Multi-Address Monitor & Live Webhooks

• Description: Proactive monitoring of the user's onchain asset status using Tatum’s native notification network instead of slow, resource-heavy polling loops.
• Technical Flow:
	1. On initial wallet setup, the system registers the target Sui public address using Tatum's Start monitoring of the address SDK method.
	2. Any real-time state mutation onchain (DeFi swap, gas burn, transfer) fires an event.
	3. Tatum broadcasts a secure webhook package to the /api/v1/tatum-webhook API backend.
	4. Backend decodes the payload, validates it using the x-payload-hash HMAC cryptographic token, and forces the Chat WebUI to refresh its context risk indicators within 1 second.
• Acceptance Criteria: System must elegantly process massive bulk payloads and automatically filter out duplicate or unrelated transaction hashes.

FR-04: Transaction Simulator Context Alignment

• Description: Pre-execution sandboxing to intercept risky or unauthorized onchain transaction commands before they write to the live network blocks.
• Technical Flow:
	1. User initiates an asset transaction or swap command inside the chat environment.
	2. VOTOI intercepts the raw execution parameters and passes them to the Tatum Simulate Transfer gateway.
	3. The sandbox evaluates expected balance modifications and structural network gas overheads.
	4. Output is matched with the current budget_risk bounds held inside Walrus Mainnet.
	5. If a breach is detected, the transaction payload is discarded, and an emergency UI block alert fires.
• Acceptance Criteria: Simulation execution time must stay under 800ms to preserve the global sub-2-second conversational responsiveness metric [14.15].


🗂️ 4. Data Requirements & Schema Layout


4.1 Storage Tier Segmentation

• Neon Postgres Cache Tier: Holds active active chat dialogue nodes, real-time message arrays, and low-latency transactional indexes.
• Walrus Memory Mainnet Tier: Acts as the unalterable, distributed backup ledger preserving compressed, structured user behavioral parameters [14.14, 14.15].

4.2 Non-Functional Compliance Constraints

• Currency Standardization: All monetary variables inside the database tables and serialized string segments must be parsed and processed using United States Dollars (USD).
• Data Masking: Private keys, key shares, and seed phrases must never be cached locally or transmitted over unencrypted REST APIs.

