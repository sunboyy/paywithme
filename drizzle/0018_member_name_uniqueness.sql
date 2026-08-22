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
-- Using SQL here does not reopen ADR-0015's choice: the decision it records is
-- about where the LIVE column value is computed on every write, not about a
-- migration that runs once.
--
-- This has to earn "byte-for-byte matches JS `.normalize('NFC').trim().toLowerCase()`"
-- rather than assume it, because plain `lower()`/`btrim()` do NOT:
--   - `lower()` folds case per the DATABASE's collation. Under a non-Unicode-aware
--     collation this under-folds (e.g. accented Latin letters pass through
--     unchanged), and under a locale-specific one it can fold WRONG (Turkish
--     `İ` -> ASCII `i`, not `i` + combining dot above) — exactly the
--     "depends on where it ran" instability `normalizeDisplayName`'s own header
--     comment rejects `toLocaleLowerCase` for. `COLLATE "und-x-icu"` (the ICU ROOT
--     locale, bundled with Postgres's ICU support since core shipped
--     `--with-icu`, PG10+) is what actually reproduces JS's locale-independent
--     Unicode default case folding — verified directly against Node for `İ`,
--     accented Latin, and plain ASCII, byte-for-byte.
--   - `btrim()` strips only the ASCII space (0x20) by default — NOT tab, NBSP, or
--     any of the other characters JS's `.trim()` treats as whitespace. The
--     `regexp_replace` below strips exactly that set (U+0009-000D, U+0020,
--     U+00A0, U+1680, U+2000-200A, U+2028-2029, U+202F, U+205F, U+3000, U+FEFF),
--     via `chr()` rather than literal characters so the migration file stays
--     grep-able and immune to editor/encoding mangling.
--
-- `normalize(..., NFC)` (Postgres 13+) still matches JS's NFC step exactly — only
-- the fold and the trim needed correcting.
WITH ws(cls) AS (
	VALUES (
		chr(9) || '-' || chr(13) || chr(32) || chr(160) || chr(5760) ||
		chr(8192) || '-' || chr(8202) || chr(8232) || '-' || chr(8233) ||
		chr(8239) || chr(8287) || chr(12288) || chr(65279)
	)
)
UPDATE "members" SET "normalized_display_name" = lower(
		regexp_replace(
			normalize("display_name", NFC),
			'^[' || ws.cls || ']+|[' || ws.cls || ']+$', '', 'g'
		) COLLATE "und-x-icu"
	)
	FROM ws
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
