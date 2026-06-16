import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { currencies } from './currencies-schema';
import * as schema from './schema';

// Import-level shape assertions for the `currencies` table (task 3.2; PLAN
// §7.5.1). No DB connection: we introspect the Drizzle table object so an
// accidental rename / wrong nullability / wrong PK is caught at unit time. The
// seeded rows are checked against the constant in `money/currencies.test.ts`.

describe('currencies drizzle table', () => {
	it('maps to the `currencies` SQL table', () => {
		expect(getTableName(currencies)).toBe('currencies');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(currencies)).sort()).toEqual([
			'code',
			'exponent',
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
	});

	it('declares `code` as the sole primary key', () => {
		const config = getTableConfig(currencies);
		// PK is on the column itself (`.primaryKey()`), so there is no composite
		// primary-key constraint; the column-level flag above is the source of truth.
		expect(config.primaryKeys).toHaveLength(0);
		expect(getTableColumns(currencies).code.primary).toBe(true);
	});

	it('is re-exported from the schema entry point', () => {
		expect(schema.currencies).toBe(currencies);
	});
});
