PROJECT.md — VOTOI (EXPENSE WATCHDOG AGENT)


🐕 1. Executive Summary & Value Proposition

VOTOI (Expense Watchdog Agent) is an autonomous, multimodal financial intelligence agent built for the Walrus x Tatum: Total Recall Hackathon under Track 2: Smart Agents for Real Life [14.14, 14.15].
The project addresses two critical challenges in modern Web3 decentralized assistance: Memory Silos (the disconnection between real-world offline receipt images and onchain transaction profiles) and Network Latency/Indexer Lag which traditionally forces conversational AI response times to degrade past acceptable thresholds (>5 seconds).

The Solution:

VOTOI introduces a 2-Tier Hybrid Storage Architecture that locks in sub-2-second chatbot response times locally while preserving decentralized, portable memory across tools and sessions by enforcing Walrus Memory Mainnet as the ultimate Canonical Source of Truth [14.14, 14.15]. It seamlessly synthesizes multi-modal inputs (receipt photos, PDFs) with automated Web3 operations using Tatum SDK & Data APIs to safeguard personal wealth [14.14, 14.15].


🧱 2. System Architecture & Data Flow

                      ┌───────────────────────────────────────────┐
                      │          USER INTERACTION INTERFACE       │
                      │   (Next.js WebUI / Telegram / Camera)     │
                      └─────────────────────┬─────────────────────┘
                                            │
                             (Real-time Actions & Prompts)
                                            ▼
                      ┌───────────────────────────────────────────┐
                      │   FAST-QUERY & LOCAL CACHING TIER (FAST)  │
                      │               Neon Postgres               │
                      └─────────────────────┬─────────────────────┘
                                            │
                      (Async Sync / Crons / Cache Miss Flow)
                                            ▼
                      ┌───────────────────────────────────────────┐
                      │     CANONICAL SOURCE OF TRUTH (VĨNH CỬU)   │
                      │          Walrus Memory Mainnet            │
                      └───────────────────────────────────────────┘
• Fast-Query Tier (Neon Postgres): Manages instant text history tracking, caches active synthesized parameters locally, and handles rapid async storage registration to unlock immediate user UI releases.
• Long-Term Memory Tier (Walrus Mainnet): Acts as the final permanent storage layer. At session completion, all unstructured interactions are compressed via background cron-jobs into concise, flattened string arrays called Clean Facts and saved using memwal.remember().



⚡ 3. Sponsor Core Integrations & Hackathon Compliance

VOTOI maximizes its technical evaluation scoring matrix (60% weight allocated to Walrus and Tatum implementation) via deep utility integration [14.15]:

A. Walrus Memory & Blob Storage ($500 Best Memory Prize Track) [14.14, 14.15]

• Blob Document Vault: Raw image data collected from smartphone cameras and financial transaction invoice PDFs are pushed directly to Walrus Blob Storage to act as verifiable, unalterable fiscal evidence.
• Deepest Learning Loop Optimization: Rather than populating sequential lines of redundant tracking logs, VOTOI utilizes an iterative Fact Mutation and Versioning Pipeline. The agent reads historical contexts from Walrus via memwal.getMemories(), uses LLM processing to aggregate patterns, increments the metadata version index, and overrides obsolete memory slots with updated behavioral states.

B. Tatum SDK, Data APIs & AI Builder ($500 Best AI Builder App Track) [14.14, 14.15]

• Real-Time Address Monitor (Webhook Notifications): Employs Tatum's native Subscription model to hook target Sui wallets. Whenever an onchain transaction triggers (gas consumption, token interaction, asset swap), Tatum pushes an authorized, HMAC-secured webhook alert straight to VOTOI's backend worker, forcing the agent to proactively adjust budget margins.
• Tatum Transaction Simulator (DeFi Sandbox Escrow): Intercepts automated payments or manual transfer prompt requests. VOTOI sends payload profiles to Tatum's Simulator suite (Simulate Transfer) to project exact asset fluctuations and gas estimations prior to signature execution. The output is evaluated against the spending limits extracted from Walrus Memory to either clear or flag the execution block.


📦 4. Memory Serialization Layout (No Em-Dashes Constraint)

To streamline parsing reliability across distinct platforms and context environments, all written entries saved through memwal.remember() reject em-dashes (—) completely and utilize vertical bar pipelines (|) as standard delimiters:
text
Format Layout:
[watchdog:fact_type] subject_identifier | behavior_pattern | action_rule


Core Payload Profiles (Denominated in USD):

• Merchant Habit Example:
[watchdog:merchant_habit] starbucks | High frequency 5 times per week with average consumption 8.50 USD | Suppress generic notifications and only alert if single charge exceeds 15.00 USD
• Budget Risk Example:
[watchdog:budget_risk] entertainment | Expended 85 percent of October gaming budget by Oct 17 | Trigger critical severity overlay and reject unauthorized automated microtransaction subscriptions


🎬 5. Demo Validation Script (State Rehydration Demonstration)

To validate the Portable Memory criterion ("picks up where it left off across tools and sessions"), VOTOI contains a public testing route /api/test/wipe-cache explicitly built for the judging panel [14.15]:
1. Cache Elimination Phase: Clicking the trigger completely clears the local Neon Postgres learned_facts cache table. Cột hiển thị bộ não Agent trống trơn.
2. Conversational Query Phase: The user opens a distinct channel (e.g., Telegram Bot) and asks: "What rules have you learned about my dining allowances?"
3. State Rehydration Phase: The server logs visually capture a direct data fetch to Walrus Mainnet via memwal.getMemories(). The flattened text facts stream back, rapidly reconstruct the local Postgres cache state, and the agent instantly answers with intact situational logic, displaying absolute memory restoration.

## 🚀 6. Core Features Deep-Dive & Execution Mechanics

VOTOI achieves its status as a "Smart Agent for Real Life" through the flawless technical execution of four advanced proprietary features, leveraging the combined capabilities of Tatum APIs and Walrus Memory Mainnet.

### 🧠 A. Cross-Session Fact Mutation & Versioning
*   **The Problem:** Traditional LLM agents accumulate memory linearly, saving redundant tracking rows for every transaction, which quickly pollutes the LLM context window and causes logic degradation.
*   **The VOTOI Mechanism:** Instead of appending duplicate logs, VOTOI operates on an iterative Mutation Loop. When a new transaction occurs, the agent pulls previous state facts from Walrus via `memwal.getMemories()`. An aggregation pipeline merges the old rule with new behavior patterns, increments the internal `version` metadata index, and executes a clean rewrite using `memwal.remember()`.
*   **Visual Impact:** Old memory blocks are flagged as mutated, and only the newest, condensed, version-controlled canonical facts are passed to the next session, allowing the agent to continuously evolve its logic.

### 🔌 B. Sui Native Automated Payment & Escrow Adapter
*   **The Problem:** Most AI financial assistants are read-only chatbots that cannot execute actions, failing the hackathon requirement of being a fully "shippable product".
*   **The VOTOI Mechanism:** Built using Tatum AI Builder, this adapter establishes a secure, bounded financial execution layer. Users can safely deposit a small allowance fund (denominated in USD/Stablecoins) into an escrow contract.
*   **The Action:** When the agent detects an authorized recurring bill (e.g., utility invoice or software subscription) that perfectly aligns with historical facts stored in Walrus, VOTOI bypasses manual user signature requirements. It calls Tatum Sui RPC to automatically execute a native asset transfer, settling the payment seamlessly without exposing the user's primary private keys.

### 🕵️‍♂️ C. Real-Time Multi-Address Monitor & Live Webhooks
*   **The Problem:** Polling RPC blocks to track wallet balances causes high latency, severe rate limits (HTTP 429), and delayed response windows.
*   **The VOTOI Mechanism:** VOTOI integrates Tatum’s Advanced Blockchain Notifications and Webhook Configuration framework. Using the Tatum SDK, the backend initiates a permanent `Start monitoring of the address` event listener on the user's Sui wallet address.
*   **The Flow:** The moment any transaction happens onchain (gas fee consumption, DeFi swap, or asset transfer), Tatum instantly fires a secure, HMAC-authenticated webhook payload (`x-payload-hash` validation) directly to VOTOI's API endpoint. The agent wakes up instantly to re-evaluate financial risk parameters in real time.

### 🔀 D. Transaction Simulator Context Alignment
*   **The Problem:** Warning a user after an unauthorized or risky DeFi transaction has already gone through fails the objective of a true protective "Watchdog".
*   **The VOTOI Mechanism:** VOTOI intercepts all outward payment requests or manual transfer prompts before they reach the blockchain wallet extension. The payload is immediately redirected to Tatum’s Blockchain Abstraction Suite (`Simulate Transfer`).
*   **The Alignment:** The simulator runs a pre-execution sandbox check to project the precise post-transaction wallet balances and exact gas requirements. VOTOI matches this simulated state change with the current `budget_risk` rules pulled from Walrus Mainnet. If the simulation indicates a breach of financial safety margins, the agent actively blocks execution and pops up a high-severity warning UI to the user.

### 💸 C. Best Use of Agent Payments Integration ($500 Bonus Track)
*   **The Paradigm Shift:** VOTOI is no longer just an observation tool; it is now an actionable financial agent. By natively incorporating the **x402 / MPP (Multi-Party Payments) Standard**, the agent can independently manage, stream, and settle programmatic split-payments or escrowed funds directly on the Sui Network.
*   **The Shippable Product Advantage:** This positions VOTOI at the absolute forefront of the newly added Tatum track, utilizing sovereign automated vault controls rather than relying on interactive user wallet approvals for every operational financial micro-turn.




