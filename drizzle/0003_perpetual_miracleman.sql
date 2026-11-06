ALTER TABLE "agent_payments" ALTER COLUMN "total_usd" SET DATA TYPE numeric(14, 4);--> statement-breakpoint
ALTER TABLE "scheduled_bills" ALTER COLUMN "amount_usd" SET DATA TYPE numeric(14, 4);--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "amount_usd" SET DATA TYPE numeric(14, 4);