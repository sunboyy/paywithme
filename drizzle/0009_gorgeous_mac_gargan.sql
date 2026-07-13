ALTER TABLE "transactions" ALTER COLUMN "occurred_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "occurred_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "created_at" SET DEFAULT now();