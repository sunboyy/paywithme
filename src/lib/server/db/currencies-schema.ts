import { pgTable, text, integer } from 'drizzle-orm/pg-core';

// Drizzle table for the supported fiat currencies (task 3.2; PLAN §7.5.1 / #19).
//
// SCHEMA-ONLY here; the 29 rows are SEEDED via the migration (PLAN §7.5.1 says
// "seeded via migration") so `pnpm db:migrate` populates them with no app code.
// The canonical data lives in `src/lib/money/currencies.ts` — this table mirrors
// it and the seed INSERT is generated from that same constant, so the TS source,
// the DB rows, and the Zod enum can't drift.
//
// Conventions mirror the hand-authored `rate-limit-schema.ts` /
// `groups-schema.ts`: camelCase property keys → snake_case columns.
//
// `code` is the PRIMARY KEY (the ISO 4217 code itself, not a surrogate id) so
// future foreign keys can reference it directly — e.g. `groups.settlement_currency`
// and `transactions.currency` (PLAN §6.1, §7.1) point at a known-good currency.
//
// `exponent` is stored PER ROW (ISO 4217 minor units: JPY/KRW/VND = 0, the rest
// = 2). No code branches on a literal "2 vs 0"; all minor-unit math reads this
// column / `getCurrency().exponent`, so a 3-decimal currency is addable later by
// adding a row — no schema or code change (PLAN §7.5).
export const currencies = pgTable('currencies', {
	// ISO 4217 alphabetic code, uppercase (e.g. 'USD'). PK so FKs can reference it.
	code: text('code').primaryKey(),
	// Human-readable display name (e.g. 'US Dollar').
	name: text('name').notNull(),
	// ISO 4217 minor-unit exponent; drives all per-currency minor-unit math.
	exponent: integer('exponent').notNull(),
	// Display symbol (e.g. '$', '฿', 'CN¥').
	symbol: text('symbol').notNull()
});
