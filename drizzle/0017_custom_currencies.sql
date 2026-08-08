-- Widen `currencies` so it can hold GROUP-DEFINED custom rows alongside the 29
-- seeded ones (issue #59; PLAN §7.5.2, §9; ADR-0014).
--
-- HAND-EDITED after `drizzle-kit generate`: the generated statement added
-- `display_code` as a single NOT-NULL column, which cannot run against a table
-- that already holds the 29 seeded rows. Split into the standard three steps —
-- add NULLABLE, BACKFILL, then SET NOT NULL — so the end state still matches the
-- snapshot exactly. The other three columns are nullable by design (they are what
-- marks a row as seeded), so they are the generated statements verbatim.
--
-- `created_at` deliberately carries NO `DEFAULT now()`: Postgres backfills a
-- defaulted column on `ADD COLUMN`, which would stamp a bogus creation time onto
-- every seeded row. Seeded rows must end up with
-- `group_id` / `created_by` / `created_at` all NULL.
ALTER TABLE "currencies" ADD COLUMN "display_code" text;--> statement-breakpoint
-- Backfill: for a seeded row the user-visible code IS the ISO 4217 primary key
-- (`code == display_code`, ADR-0014 decision 3). Custom rows do not exist yet.
UPDATE "currencies" SET "display_code" = "code" WHERE "display_code" IS NULL;--> statement-breakpoint
ALTER TABLE "currencies" ALTER COLUMN "display_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN "created_at" timestamp;--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Per-group uniqueness of the USER-VISIBLE code. `group_id IS NULL` (seeded) rows
-- are not constrained — Postgres treats NULLs as distinct — and don't need to be:
-- the `code` PK already makes their `display_code` unique.
CREATE UNIQUE INDEX "currencies_group_id_display_code_unique" ON "currencies" USING btree ("group_id","display_code");
