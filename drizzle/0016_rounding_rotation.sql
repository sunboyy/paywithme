ALTER TABLE "groups" ADD COLUMN "next_rounding_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "rounding_seq" integer DEFAULT 0 NOT NULL;