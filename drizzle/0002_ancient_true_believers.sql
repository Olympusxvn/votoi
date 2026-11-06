CREATE TABLE "scheduled_bills" (
	"bill_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"payee_name" text NOT NULL,
	"recipient" text NOT NULL,
	"amount_usd" numeric(14, 2) NOT NULL,
	"frequency" text DEFAULT 'once' NOT NULL,
	"next_due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allowance_id" text,
	"last_digest" text,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_bills_cap_50_usd" CHECK ("scheduled_bills"."amount_usd" <= 50.00)
);
--> statement-breakpoint
ALTER TABLE "agent_payments" ADD COLUMN "transport" text DEFAULT 'tatum' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_bills" ADD CONSTRAINT "scheduled_bills_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_bills_user_idx" ON "scheduled_bills" USING btree ("user_id","status","next_due_at");