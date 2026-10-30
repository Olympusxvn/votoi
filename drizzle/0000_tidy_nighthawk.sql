CREATE TABLE "agent_payments" (
	"payment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"standard" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"total_usd" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"gas_sponsored" boolean DEFAULT false NOT NULL,
	"gas_usd" numeric(14, 4),
	"tx_hash" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "agent_payments_cap_50_usd" CHECK ("agent_payments"."total_usd" <= 50.00)
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learned_facts" (
	"fact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"fact_type" text NOT NULL,
	"subject" text NOT NULL,
	"fact_payload" jsonb NOT NULL,
	"walrus_blob_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learned_facts_no_emdash" CHECK (("learned_facts"."fact_payload" ->> 'serializedString') NOT LIKE '%—%')
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"upload_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"walrus_blob_id" text NOT NULL,
	"mime_type" text NOT NULL,
	"kind" text NOT NULL,
	"ocr_status" text DEFAULT 'queued' NOT NULL,
	"transaction_id" uuid,
	"raw_text" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_rehydrated_at" timestamp with time zone,
	"last_mutation_at" timestamp with time zone,
	"walrus_fact_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"tx_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"merchant_name" text NOT NULL,
	"amount_usd" numeric(14, 2) NOT NULL,
	"category" text,
	"source" text NOT NULL,
	"tx_hash" text,
	"walrus_blob_id" text,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"wallet_address" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"telegram_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_payments" ADD CONSTRAINT "agent_payments_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_facts" ADD CONSTRAINT "learned_facts_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_transaction_id_transactions_tx_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("tx_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_payments_user_idx" ON "agent_payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("user_id","session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "learned_facts_slot_uq" ON "learned_facts" USING btree ("user_id","fact_type","subject");--> statement-breakpoint
CREATE INDEX "learned_facts_user_idx" ON "learned_facts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "media_uploads_status_idx" ON "media_uploads" USING btree ("ocr_status");--> statement-breakpoint
CREATE INDEX "transactions_user_time_idx" ON "transactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_user_merchant_idx" ON "transactions" USING btree ("user_id","merchant_name");