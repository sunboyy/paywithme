-- Active-member display-name uniqueness, per group (issue #75; PLAN §6.1–§6.3, §9;
-- ADR-0015).
--
-- HAND-EDITED after `drizzle-kit generate`, exactly like `0017_custom_currencies`:
-- the generated statement added `normalized_display_name` as a single NOT-NULL
-- column, which cannot run against a table that already holds member rows. Split
-- into the standard three steps — add NULLABLE, BACKFILL, then SET NOT NULL — so the
-- end state still matches the snapshot exactly.
ALTER TABLE "members" ADD COLUMN "normalized_display_name" text;--> statement-breakpoint
-- Backfill the canonical key for rows that predate the column. This is the ONE
-- place the rule is written in SQL; from here on the app computes it
-- (`displayNameValues` in `src/lib/server/member-name.ts`), which is what ADR-0015
-- pins down so the write path and the name-resolution path share one rule.
--
-- `normalize(..., NFC)` (Postgres 13+) is used ONLY here, so this one-shot backfill
-- produces byte-for-byte what JS `.normalize('NFC').trim().toLowerCase()` would.
-- Using it does not reopen ADR-0015's choice: the decision it records is about
-- where the LIVE column value is computed on every write, not about a migration
-- that runs once.
UPDATE "members" SET "normalized_display_name" = lower(btrim(normalize("display_name", NFC)))
	WHERE "normalized_display_name" IS NULL;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "normalized_display_name" SET NOT NULL;--> statement-breakpoint
-- The constraint itself: no two ACTIVE members of a group share a normalized display
-- name. PARTIAL on `deactivated_at IS NULL`, mirroring
-- `members_group_id_user_id_unique` — a deactivated member keeps their name in the
-- ledger forever, so constraining them would burn that name for the group, and
-- renaming one (the escape hatch for a blocked reactivation, §6.3) must stay free.
--
-- NO RECONCILIATION SHIPS WITH THIS (ADR-0015, risk accepted pre-production): if a
-- database already holds two active members of one group with the same normalized
-- name, THIS STATEMENT FAILS and the migration stops. That is the intended, loud
-- outcome — rename or deactivate one of them, then re-run.
CREATE UNIQUE INDEX "members_group_id_normalized_display_name_unique" ON "members" USING btree ("group_id","normalized_display_name") WHERE "members"."deactivated_at" is null;
