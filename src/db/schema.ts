import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * VOTOI fast cache tier (Neon Postgres).
 *
 * This database is a VOLATILE cache. The canonical source of truth is
 * Walrus Memory Mainnet; every row in learned_facts mirrors a fact that
 * was committed there first (RULE.md Boundary 2).
 *
 * Global rules enforced at the schema level:
 * - All money is USD. Amount columns are numeric(14, 4) named *Usd and
 *   are returned by Drizzle as strings, so no float drift can occur.
 *   Four decimals keep sub-cent agent micro-payments exact.
 * - Serialized memory strings must never contain an em-dash (CHECK on
 *   learned_facts). Format: [watchdog:fact_type] subject | pattern | rule
 * - Agent payments are hard-capped at 50.00 USD per transaction
 *   (CHECK on agent_payments, RULE.md Rule 3).
 */

// ---------------------------------------------------------------- users

export const users = pgTable("users", {
  // The user's Sui wallet address doubles as the public user_id in APIs.
  walletAddress: text("wallet_address").primaryKey(),
  displayName: text("display_name"),
  telegramId: text("telegram_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------- learned facts

export type FactType = "merchant_habit" | "budget_risk" | "payment_rule" | "preference";
export type FactStatus = "active" | "mutated" | "pending_sync";

/** JSONB payload of a learned fact. serializedString is the exact string
 *  stored on Walrus, so a cache rebuild never needs re-serialization. */
export interface FactPayload {
  serializedString: string;
}

export const learnedFacts = pgTable(
  "learned_facts",
  {
    factId: uuid("fact_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.walletAddress, { onDelete: "cascade" }),
    // Kept as plain text (not a pg enum) so new fact types ship without a
    // migration; the FactType union above is the TypeScript-side guard.
    factType: text("fact_type").notNull(),
    // Slot key inside (user, type): merchant name, budget category, "global".
    subject: text("subject").notNull(),
    factPayload: jsonb("fact_payload").$type<FactPayload>().notNull(),
    // Null until the fact is committed to Walrus Mainnet.
    walrusBlobId: text("walrus_blob_id"),
    // Monotonic mutation counter. Incremented on every fact rewrite.
    version: integer("version").notNull().default(1),
    status: text("status").$type<FactStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One canonical slot per (user, fact type, subject). A mutation updates
    // this row in place instead of appending a new log line.
    uniqueIndex("learned_facts_slot_uq").on(t.userId, t.factType, t.subject),
    index("learned_facts_user_idx").on(t.userId),
    // RULE.md Boundary 3, enforced by the database itself: reject any
    // serialized memory string containing an em-dash.
    check(
      "learned_facts_no_emdash",
      sql`(${t.factPayload} ->> 'serializedString') NOT LIKE '%—%'`,
    ),
  ],
);

// ----------------------------------------------------------- transactions

export type TransactionSource = "receipt_ocr" | "onchain" | "manual" | "agent_payment";

export const transactions = pgTable(
  "transactions",
  {
    txId: uuid("tx_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.walletAddress, { onDelete: "cascade" }),
    merchantName: text("merchant_name").notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 4 }).notNull(),
    category: text("category"),
    source: text("source").$type<TransactionSource>().notNull(),
    // Onchain digest. Unique so duplicate Tatum webhooks are dropped by
    // the database, not by application code (FR-03). Null for offchain rows.
    txHash: text("tx_hash").unique(),
    // Walrus blob holding the receipt or invoice evidence, when present.
    walrusBlobId: text("walrus_blob_id"),
    note: text("note"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_user_time_idx").on(t.userId, t.occurredAt),
    index("transactions_user_merchant_idx").on(t.userId, t.merchantName),
  ],
);

// ---------------------------------------------------------- media uploads

export type OcrStatus = "queued" | "processing" | "done" | "failed";

export const mediaUploads = pgTable(
  "media_uploads",
  {
    uploadId: uuid("upload_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.walletAddress, { onDelete: "cascade" }),
    // Raw file evidence lives on Walrus Blob Storage, never in Postgres.
    walrusBlobId: text("walrus_blob_id").notNull(),
    mimeType: text("mime_type").notNull(),
    kind: text("kind").$type<"receipt" | "invoice">().notNull(),
    // The chat route inserts with "queued" and returns immediately; the
    // asyncOcr worker flips this through processing to done/failed so the
    // UI thread never waits on OCR (RULE.md Boundary 1).
    ocrStatus: text("ocr_status").$type<OcrStatus>().notNull().default("queued"),
    transactionId: uuid("transaction_id").references(() => transactions.txId),
    rawText: text("raw_text"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("media_uploads_status_idx").on(t.ocrStatus)],
);

// ---------------------------------------------------------- chat messages

export const chatMessages = pgTable(
  "chat_messages",
  {
    messageId: uuid("message_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.walletAddress, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_session_idx").on(t.userId, t.sessionId, t.createdAt)],
);

// --------------------------------------------------------- agent payments

export type PaymentStandard = "x402" | "mpp";
export type PaymentStatus =
  | "pending"
  | "simulated"
  | "awaiting_approval"
  | "broadcast"
  | "settled"
  | "blocked"
  | "failed";

export interface PaymentRecipient {
  address: string;
  amountUsd: number;
}

export const agentPayments = pgTable(
  "agent_payments",
  {
    paymentId: uuid("payment_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.walletAddress, { onDelete: "cascade" }),
    standard: text("standard").$type<PaymentStandard>().notNull(),
    recipients: jsonb("recipients").$type<PaymentRecipient[]>().notNull(),
    totalUsd: numeric("total_usd", { precision: 14, scale: 4 }).notNull(),
    status: text("status").$type<PaymentStatus>().notNull().default("pending"),
    // True when the facilitator or sponsor pays SUI gas instead of the agent.
    gasSponsored: boolean("gas_sponsored").notNull().default(false),
    gasUsd: numeric("gas_usd", { precision: 14, scale: 4 }),
    txHash: text("tx_hash"),
    failureReason: text("failure_reason"),
    // Which chain transport settled the payment (tatum-grpc preferred).
    transport: text("transport").notNull().default("tatum"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_payments_user_idx").on(t.userId, t.createdAt),
    // RULE.md Rule 3 enclosure, enforced by the database: an automated
    // agent payment above 50.00 USD can never be recorded as executable.
    check("agent_payments_cap_50_usd", sql`${t.totalUsd} <= 50.00`),
  ],
);

// -------------------------------------------------------- scheduled bills

export type BillFrequency = "once" | "weekly" | "monthly";
export type BillStatus = "active" | "paused" | "done";

export const scheduledBills = pgTable(
  "scheduled_bills",
  {
    billId: uuid("bill_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.walletAddress, { onDelete: "cascade" }),
    payeeName: text("payee_name").notNull(),
    recipient: text("recipient").notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 4 }).notNull(),
    frequency: text("frequency").$type<BillFrequency>().notNull().default("once"),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<BillStatus>().notNull().default("active"),
    // Pinned allowance to spend through; null means any covering allowance.
    allowanceId: text("allowance_id"),
    lastDigest: text("last_digest"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_bills_user_idx").on(t.userId, t.status, t.nextDueAt),
    check("scheduled_bills_cap_50_usd", sql`${t.amountUsd} <= 50.00`),
  ],
);

// -------------------------------------------------------- pending writes

/**
 * Durable Walrus write pipeline (lesson from upstream issues #1048 and
 * #1049 and the WalPen project's write recovery): a fact mutation first
 * persists its frozen intent and deterministic idempotency key here,
 * then submits to MemWal, then records the accepted job_id on the same
 * row. If the worker dies anywhere in that sequence, the next pass can
 * poll the known job (or safely replay the same key) instead of leaving
 * an uncertain write. The row is deleted once the fact is active in
 * learned_facts with its blob id.
 */
export const pendingWrites = pgTable(
  "pending_writes",
  {
    writeId: uuid("write_id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.walletAddress, { onDelete: "cascade" }),
    factType: text("fact_type").notNull(),
    subject: text("subject").notNull(),
    serialized: text("serialized").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    version: integer("version").notNull(),
    // Null between intent persistence and MemWal job acceptance.
    walrusJobId: text("walrus_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pending_writes_user_idx").on(t.userId),
    check("pending_writes_no_emdash", sql`${t.serialized} NOT LIKE '%—%'`),
  ],
);

// -------------------------------------------------------------- sync state

/** Rehydration bookkeeping: one row per user, used by the wipe-cache demo
 *  and to prove the cache was rebuilt from Walrus, not from local state. */
export const syncState = pgTable("sync_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.walletAddress, { onDelete: "cascade" }),
  lastRehydratedAt: timestamp("last_rehydrated_at", { withTimezone: true }),
  lastMutationAt: timestamp("last_mutation_at", { withTimezone: true }),
  walrusFactCount: integer("walrus_fact_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ------------------------------------------------------------ row types

export type User = typeof users.$inferSelect;
export type LearnedFact = typeof learnedFacts.$inferSelect;
export type NewLearnedFact = typeof learnedFacts.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type MediaUpload = typeof mediaUploads.$inferSelect;
export type PendingWrite = typeof pendingWrites.$inferSelect;
export type AgentPayment = typeof agentPayments.$inferSelect;
export type NewAgentPayment = typeof agentPayments.$inferInsert;
export type ScheduledBill = typeof scheduledBills.$inferSelect;
export type NewScheduledBill = typeof scheduledBills.$inferInsert;
