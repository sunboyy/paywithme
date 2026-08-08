import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
	currencies,
	generateCustomCurrencyCode,
	CUSTOM_CURRENCY_CODE_PREFIX
} from './currencies-schema';
import { CURRENCIES, CURRENCY_CODES } from '../../money/currencies';
import * as schema from './schema';

// Import-level shape assertions for the `currencies` table (task 3.2; PLAN
// §7.5.1, and the issue-#59 widening for group-defined custom currencies —
// PLAN §7.5.2 / ADR-0014). No DB connection: we introspect the Drizzle table
// object so an accidental rename / wrong nullability / wrong PK / lost FK is
// caught at unit time. The seeded rows are checked against the constant in
// `money/currencies.test.ts`; the real-DB behaviour of the new column + index
// (backfill, per-group uniqueness, cascade) is covered by
// `tests/integration/custom-currency-schema.test.ts`.

describe('currencies drizzle table', () => {
	it('maps to the `currencies` SQL table', () => {
		expect(getTableName(currencies)).toBe('currencies');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(currencies)).sort()).toEqual([
			'code',
			'createdAt',
			'createdBy',
			'displayCode',
			'exponent',
			'groupId',
			'name',
			'symbol'
		]);
	});

	it('maps property keys to snake_case columns with the right nullability', () => {
		const cols = getTableColumns(currencies);
		expect(cols.code.name).toBe('code');
		// `code` is the PRIMARY KEY (so FKs can reference it) → not null.
		expect(cols.code.primary).toBe(true);
		expect(cols.code.notNull).toBe(true);

		expect(cols.name.name).toBe('name');
		expect(cols.name.notNull).toBe(true);

		expect(cols.exponent.name).toBe('exponent');
		expect(cols.exponent.notNull).toBe(true);
		expect(cols.exponent.columnType).toBe('PgInteger');

		expect(cols.symbol.name).toBe('symbol');
		expect(cols.symbol.notNull).toBe(true);

		// `display_code` is NOT NULL for BOTH kinds of row, so every display path
		// has exactly one column to read (PLAN §7.5.2).
		expect(cols.displayCode.name).toBe('display_code');
		expect(cols.displayCode.notNull).toBe(true);

		// The three "custom row only" columns are NULLABLE — a NULL `group_id` is
		// what MARKS one of the 29 seeded rows (ADR-0014 decision 3).
		expect(cols.groupId.name).toBe('group_id');
		expect(cols.groupId.notNull).toBe(false);

		expect(cols.createdBy.name).toBe('created_by');
		expect(cols.createdBy.notNull).toBe(false);

		expect(cols.createdAt.name).toBe('created_at');
		expect(cols.createdAt.notNull).toBe(false);
		expect(cols.createdAt.columnType).toBe('PgTimestamp');
	});

	it('declares `code` as the sole primary key (unchanged — the point of ADR-0014)', () => {
		const config = getTableConfig(currencies);
		// PK is on the column itself (`.primaryKey()`), so there is no composite
		// primary-key constraint; the column-level flag above is the source of truth.
		expect(config.primaryKeys).toHaveLength(0);
		expect(getTableColumns(currencies).code.primary).toBe(true);
		// Custom rows are keyed by an OPAQUE `code`, NOT by a composite
		// (group_id, code) PK — that is what keeps `transactions.currency`'s FK intact.
	});

	it('gives `created_at` no DB-level default (Postgres would backfill the seeded rows)', () => {
		const cols = getTableColumns(currencies);
		expect(cols.createdAt.hasDefault).toBe(false);
		expect(cols.createdAt.default).toBeUndefined();
	});

	it('has a cascading FK to groups and a set-null FK to user', () => {
		const { foreignKeys } = getTableConfig(currencies);
		const byCol = (col: string) =>
			foreignKeys.find((fk) => fk.reference().columns.some((c) => c.name === col));

		// A custom currency's lifetime is its group's lifetime (ADR-0014).
		expect(byCol('group_id')?.onDelete).toBe('cascade');
		expect(byCol('group_id')?.reference().foreignTable).toBe(schema.groups);

		// Deleting the author must NOT delete a currency the ledger references.
		expect(byCol('created_by')?.onDelete).toBe('set null');
		expect(byCol('created_by')?.reference().foreignTable).toBe(schema.user);
	});

	it('declares a UNIQUE index on (group_id, display_code)', () => {
		const { indexes } = getTableConfig(currencies);
		const idx = indexes.find((i) => i.config.name === 'currencies_group_id_display_code_unique');
		expect(idx).toBeDefined();
		expect(idx?.config.unique).toBe(true);
		// `group_id` leads, so the index also serves "list this group's currencies".
		expect(idx?.config.columns.map((c) => (c as { name?: string }).name)).toEqual([
			'group_id',
			'display_code'
		]);
		// No `where` predicate: unlike `members_group_id_user_id_unique` this is NOT
		// partial — seeded rows are already unique via the `code` PK.
		expect(idx?.config.where).toBeUndefined();
	});

	it('is re-exported from the schema entry point', () => {
		expect(schema.currencies).toBe(currencies);
	});
});

describe('generateCustomCurrencyCode', () => {
	it('prefixes the opaque code so it can never be an ISO 4217 code', () => {
		const code = generateCustomCurrencyCode();
		expect(code.startsWith(CUSTOM_CURRENCY_CODE_PREFIX)).toBe(true);
		// ISO 4217 alphabetic = exactly 3 uppercase letters; numeric = exactly 3 digits.
		expect(code).not.toMatch(/^[A-Z]{3}$/);
		expect(code).not.toMatch(/^[0-9]{3}$/);
		expect(code.length).toBeGreaterThan(3);
	});

	it('can never collide with a seeded code (present or future ISO codes)', () => {
		const code = generateCustomCurrencyCode();
		expect(CURRENCY_CODES).not.toContain(code);
		// The prefix is lowercase + `_`, which no ISO code may contain at all — so
		// this holds for codes ISO has not assigned yet, not just today's 29.
		expect(CUSTOM_CURRENCY_CODE_PREFIX).toMatch(/^[a-z]+_$/);
		for (const c of CURRENCIES) {
			expect(c.code.startsWith(CUSTOM_CURRENCY_CODE_PREFIX)).toBe(false);
		}
	});

	it('is globally unique across calls', () => {
		const codes = new Set(Array.from({ length: 500 }, () => generateCustomCurrencyCode()));
		expect(codes.size).toBe(500);
	});

	it('backs the `code` column default, so a custom-row insert omits `code`', () => {
		const col = getTableColumns(currencies).code;
		expect(col.hasDefault).toBe(true);
		expect(typeof col.defaultFn).toBe('function');
		const generated = col.defaultFn?.() as string;
		expect(generated.startsWith(CUSTOM_CURRENCY_CODE_PREFIX)).toBe(true);
	});
});

// Guard the HAND-EDITED widening migration (issue #59). `drizzle-kit generate`
// emits a single `ADD COLUMN "display_code" text NOT NULL`, which cannot run
// against the already-seeded table; the committed migration splits it into
// add-nullable → backfill → set-not-null. If someone regenerates the migration
// and drops the backfill, `pnpm db:migrate` breaks on every existing database —
// so assert the shape here, where the fast gate sees it (the real-DB assertion
// lives in `tests/integration/custom-currency-schema.test.ts`).
describe('widening migration', () => {
	function readWideningMigration(): string {
		const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');
		const matches = readdirSync(drizzleDir)
			.filter((f) => f.endsWith('.sql'))
			.map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
			.filter((sql) => /ADD COLUMN "display_code"/.test(sql));
		expect(matches, 'exactly one migration should add display_code').toHaveLength(1);
		return matches[0];
	}

	const sql = readWideningMigration();

	it('adds `display_code` NULLABLE, then backfills, then sets NOT NULL', () => {
		const addIdx = sql.indexOf('ADD COLUMN "display_code" text;');
		const backfillIdx = sql.search(/UPDATE "currencies" SET "display_code" = "code"/);
		const notNullIdx = sql.indexOf('ALTER COLUMN "display_code" SET NOT NULL');

		expect(addIdx, 'display_code must be added NULLABLE').toBeGreaterThan(-1);
		expect(backfillIdx, 'display_code must be backfilled from code').toBeGreaterThan(addIdx);
		expect(notNullIdx, 'display_code must end up NOT NULL').toBeGreaterThan(backfillIdx);
		// The generated `ADD COLUMN ... NOT NULL` one-liner must NOT be present.
		expect(sql).not.toContain('ADD COLUMN "display_code" text NOT NULL');
	});

	it('adds group_id / created_by / created_at as nullable, with no created_at default', () => {
		expect(sql).toContain('ADD COLUMN "group_id" text;');
		expect(sql).toContain('ADD COLUMN "created_by" text;');
		expect(sql).toContain('ADD COLUMN "created_at" timestamp;');
		// A DB default would have backfilled a bogus creation time onto the 29 seeded rows.
		expect(sql).not.toMatch(/ADD COLUMN "created_at" timestamp DEFAULT/);
	});

	it('creates the unique index and both FKs with the intended onDelete', () => {
		expect(sql).toContain(
			'CREATE UNIQUE INDEX "currencies_group_id_display_code_unique" ON "currencies" USING btree ("group_id","display_code")'
		);
		expect(sql).toMatch(/REFERENCES "public"\."groups"\("id"\) ON DELETE cascade/);
		expect(sql).toMatch(/REFERENCES "public"\."user"\("id"\) ON DELETE set null/);
	});

	it('does not touch the `code` primary key or the transactions.currency FK', () => {
		expect(sql).not.toMatch(/DROP CONSTRAINT/);
		expect(sql).not.toMatch(/PRIMARY KEY/);
		expect(sql).not.toMatch(/ALTER TABLE "transactions"/);
	});
});
