CREATE TABLE "pending_writes" (
	"write_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"fact_type" text NOT NULL,
	"subject" text NOT NULL,
	"serialized" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"version" integer NOT NULL,
	"walrus_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_writes_no_emdash" CHECK ("pending_writes"."serialized" NOT LIKE '%—%')
);
--> statement-breakpoint
ALTER TABLE "pending_writes" ADD CONSTRAINT "pending_writes_user_id_users_wallet_address_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("wallet_address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_writes_user_idx" ON "pending_writes" USING btree ("user_id");