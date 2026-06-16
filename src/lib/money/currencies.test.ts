import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CURRENCIES, CURRENCY_CODES, getCurrency, type Currency } from './currencies';

// Unit tests for the canonical currency data (PLAN §7.5.1 / #19). These lock the
// exact set of 29 currencies and their per-row exponents, and prove the DB seed
// migration can't silently drift from this TS source.

// The three currencies whose ISO 4217 minor-unit exponent is 0 (PLAN §7.5.1).
const ZERO_EXPONENT = ['JPY', 'KRW', 'VND'];

describe('CURRENCIES constant', () => {
	it('has exactly 29 entries', () => {
		expect(CURRENCIES).toHaveLength(29);
	});

	it('has unique, uppercase ISO codes', () => {
		const codes = CURRENCIES.map((c) => c.code);
		expect(new Set(codes).size).toBe(codes.length);
		for (const code of codes) {
			expect(code).toBe(code.toUpperCase());
			expect(code).toMatch(/^[A-Z]{3}$/);
		}
	});

	it('gives JPY/KRW/VND exponent 0 and every other code exponent 2', () => {
		for (const c of CURRENCIES) {
			if (ZERO_EXPONENT.includes(c.code)) {
				expect(c.exponent, `${c.code} should be 0`).toBe(0);
			} else {
				expect(c.exponent, `${c.code} should be 2`).toBe(2);
			}
		}
		// And the zero-exponent set is *exactly* those three (no extras, none missing).
		expect(
			CURRENCIES.filter((c) => c.exponent === 0)
				.map((c) => c.code)
				.sort()
		).toEqual([...ZERO_EXPONENT].sort());
	});

	it('gives every entry a non-empty name and symbol', () => {
		for (const c of CURRENCIES) {
			expect(c.name.trim().length, `${c.code} name`).toBeGreaterThan(0);
			expect(c.symbol.trim().length, `${c.code} symbol`).toBeGreaterThan(0);
		}
	});

	it('exposes CURRENCY_CODES as the codes of CURRENCIES in order', () => {
		expect(CURRENCY_CODES).toEqual(CURRENCIES.map((c) => c.code));
	});
});

describe('getCurrency', () => {
	it('returns exponent 2 / "฿" for THB', () => {
		const thb = getCurrency('THB') as Currency;
		expect(thb).toBeDefined();
		expect(thb.exponent).toBe(2);
		expect(thb.symbol).toBe('฿');
	});

	it('returns exponent 0 for JPY', () => {
		const jpy = getCurrency('JPY') as Currency;
		expect(jpy).toBeDefined();
		expect(jpy.exponent).toBe(0);
	});

	it('returns undefined for an unknown code', () => {
		expect(getCurrency('XXX')).toBeUndefined();
		expect(getCurrency('BTC')).toBeUndefined();
	});

	it('is case-sensitive (uppercase ISO only) — lowercase misses', () => {
		expect(getCurrency('usd')).toBeUndefined();
		expect(getCurrency('USD')).toBeDefined();
	});

	it('resolves every entry to itself (O(1) lookup parity)', () => {
		for (const c of CURRENCIES) {
			expect(getCurrency(c.code)).toEqual(c);
		}
	});
});

// Parity guard: the committed seed migration must INSERT one row per code in the
// constant with the matching name/exponent/symbol, so the DB seed can never
// silently drift from the TS source of truth (PLAN §7.5.1 "seeded via migration").
describe('seed migration ↔ constant parity', () => {
	// Locate the migration carrying the `currencies` seed by content (the filename
	// hash is drizzle-kit-generated and may change if the migration is regenerated).
	function readCurrencySeedMigration(): string {
		const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');
		const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'));
		const matches = sqlFiles
			.map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
			.filter((sql) => /INSERT INTO "currencies"/.test(sql));
		expect(matches, 'exactly one migration should seed currencies').toHaveLength(1);
		return matches[0];
	}

	const sql = readCurrencySeedMigration();

	it('is idempotent (ON CONFLICT upsert)', () => {
		expect(sql).toMatch(/ON CONFLICT \("code"\) DO UPDATE SET/);
	});

	it('contains an INSERT value row for every currency in the constant', () => {
		for (const c of CURRENCIES) {
			// e.g. ('THB', 'Thai Baht', 2, '฿')
			const escName = c.name.replace(/'/g, "''");
			const escSymbol = c.symbol.replace(/'/g, "''");
			const row = `('${c.code}', '${escName}', ${c.exponent}, '${escSymbol}')`;
			expect(sql, `missing seed row for ${c.code}`).toContain(row);
		}
	});

	it('seeds exactly 29 value rows (no extras)', () => {
		const valueRows = sql.match(/\(\s*'[A-Z]{3}',/g) ?? [];
		expect(valueRows).toHaveLength(29);
	});
});
