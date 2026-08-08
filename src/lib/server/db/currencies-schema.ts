import { pgTable, text, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';
import { groups } from './groups-schema';

// Drizzle table for currencies (task 3.2; PLAN §7.5.1 / #19) — widened by issue
// #59 to also hold GROUP-DEFINED custom currencies (PLAN §7.5.2; ADR-0014).
//
// SCHEMA-ONLY here; the 29 SEEDED rows are populated via migration (PLAN §7.5.1
// says "seeded via migration") so `pnpm db:migrate` fills them with no app code.
// The canonical data for those rows lives in `src/lib/money/currencies.ts` — the
// seed INSERT is generated from that same constant, so the TS source, the DB rows,
// and the Zod enum can't drift. `CURRENCY_CODES` / `currencyCodeSchema` keep
// meaning "the seeded 29" (they guard `groups.settlement_currency`, which a custom
// currency may NEVER be — ADR-0014 decision 1); they are deliberately NOT widened
// to cover custom rows.
//
// Conventions mirror the hand-authored `rate-limit-schema.ts` /
// `groups-schema.ts`: camelCase property keys → snake_case columns.
//
// ── Two kinds of row, one table (ADR-0014 decision 3) ────────────────────────
//   - SEEDED row: `group_id IS NULL`, `code == display_code` (the ISO 4217 code),
//     `created_by` / `created_at` NULL. Global, usable by every group.
//   - CUSTOM row: `group_id` = the owning group, `code` is a GENERATED, globally
//     unique, OPAQUE string (see `generateCustomCurrencyCode`), and `display_code`
//     is what the member typed (`BEER`). Usable only inside that group, and only
//     as a transaction's ENTRY currency.
//
// `code` STAYS THE PRIMARY KEY. That is the load-bearing detail of ADR-0014:
// `transactions.currency → currencies.code` (and `groups.settlement_currency`'s
// value space, and every existing join) is unchanged, so nothing in the ledger has
// to learn that two kinds of currency exist. Per-group uniqueness of the
// USER-VISIBLE code is enforced by the `(group_id, display_code)` unique index
// instead of by the PK. A separate `group_currencies` table was rejected precisely
// because it would have cost that FK — see ADR-0014 "Why not a separate
// `group_currencies` table".
//
// `exponent` is stored PER ROW (ISO 4217 minor units: JPY/KRW/VND = 0, the rest
// = 2; a custom row may pick any 0–3). No code branches on a literal "2 vs 0"; all
// minor-unit math reads this column / the resolved currency descriptor, so a
// 3-decimal currency is addable by adding a row — no schema or code change
// (PLAN §7.5).

/**
 * Prefix on every generated (custom) currency `code`.
 *
 * Lowercase + `_` is what makes an opaque code UNSPOOFABLE as a currency code:
 * ISO 4217 identifiers are exactly three UPPERCASE letters (alphabetic) or three
 * digits (numeric), so a `cur_…` code cannot collide with any ISO code that
 * exists today or is assigned in the future — nor with any seeded row, whose
 * `code` is one of those three-letter codes.
 */
export const CUSTOM_CURRENCY_CODE_PREFIX = 'cur_';

/**
 * Generate the opaque primary key for a group-defined custom currency row
 * (ADR-0014 decision 3).
 *
 * Globally unique (UUIDv4, same in-app-owns-identity convention as every other
 * text PK in this schema) and prefixed so it can never be mistaken for — or
 * collide with — an ISO 4217 code. This value is an INTERNAL identifier only: it
 * is never shown to a user and never emitted by the API / agent surfaces, which
 * resolve `display_code` instead (PLAN §7.5.2 "Display and formatting"). Wired as
 * the column's `$defaultFn`, so inserting a custom row simply omits `code`.
 */
export function generateCustomCurrencyCode(): string {
	return `${CUSTOM_CURRENCY_CODE_PREFIX}${crypto.randomUUID()}`;
}

export const currencies = pgTable(
	'currencies',
	{
		// PK, and the FK target of `transactions.currency`. For a seeded row this is
		// the uppercase ISO 4217 code ('USD'); for a custom row it is the OPAQUE
		// generated id above (never user-visible — use `displayCode` for display).
		code: text('code')
			.primaryKey()
			.$defaultFn(() => generateCustomCurrencyCode()),
		// Human-readable display name (e.g. 'US Dollar'). Member-authored on a
		// custom row → wrap it wherever it reaches an agent (ADR-0003 / ADR-0004).
		name: text('name').notNull(),
		// ISO 4217 minor-unit exponent (0–3); drives all per-currency minor-unit math.
		// FROZEN on a custom row once any transaction references it (ADR-0014
		// decision 5) — changing it would reinterpret every stored amount.
		exponent: integer('exponent').notNull(),
		// Display symbol (e.g. '$', '฿', 'CN¥'). Member-authored on a custom row.
		symbol: text('symbol').notNull(),
		// The USER-VISIBLE code. `code` for a seeded row; what the member typed
		// (short, uppercased) for a custom row. NOT NULL for both kinds, so every
		// display path has exactly one column to read and never leaks the opaque
		// `code`. Also frozen on first reference (ADR-0014 decision 5).
		displayCode: text('display_code').notNull(),
		// Owning group, or NULL for one of the 29 seeded rows. `cascade`: a custom
		// currency's lifetime is the group's lifetime (ADR-0014 "Why not per-user or
		// account-wide currencies"), and it is only ever referenced by that group's
		// transactions, which cascade with the group too. Groups are SOFT-deleted in
		// v1, so this only fires in non-v1 hard cleanup — same reasoning as
		// `members.group_id` / `invites.group_id`.
		groupId: text('group_id').references(() => groups.id, { onDelete: 'cascade' }),
		// Author of a custom row → better-auth user.id; NULL for seeded rows.
		// `set null` (like `members.user_id`, the other nullable user FK): deleting a
		// user must not delete a currency the group's transactions depend on, and
		// NULL is already a valid, meaningful state for this column.
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		// When the custom row was defined; NULL for seeded rows. DELIBERATELY has no
		// DB-level `DEFAULT now()`: Postgres backfills a defaulted column on
		// `ADD COLUMN`, which would have stamped a bogus creation time onto all 29
		// seeded rows. The service that creates a custom currency sets it explicitly.
		createdAt: timestamp('created_at')
	},
	(table) => [
		// Per-group uniqueness of the user-visible code (PLAN §7.5.2; ADR-0014
		// decision 3). Two groups may each define `BEER`, and a group may reuse a
		// seeded code as its own display code — only a duplicate WITHIN one group is
		// rejected. Seeded rows (`group_id IS NULL`) are not constrained by this
		// index at all (Postgres treats NULLs as distinct); their uniqueness is
		// already guaranteed by the `code` primary key, since `code == display_code`.
		//
		// `group_id` leads the index, so it doubles as the lookup path for "list this
		// group's custom currencies" — no separate `currencies(group_id)` index.
		uniqueIndex('currencies_group_id_display_code_unique').on(table.groupId, table.displayCode)
	]
);
