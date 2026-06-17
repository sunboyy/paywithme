import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CATEGORIES, getCategory, categoriesFor, type Category } from './categories';

// Unit tests for the canonical category data (PLAN §7.3). These lock the exact
// fixed set of 14 categories (10 spending + 4 transfer), their names → lucide
// icons → applies_to, the stable slug ids and per-set sort order, and prove the
// DB seed migration can't silently drift from this TS source.

// The exact specced rows from PLAN §7.3, in table order, as the source of truth
// for these assertions (independent of the constant's own ordering).
const EXPECTED_SPENDING: ReadonlyArray<[string, string]> = [
	['Food & Drink', 'utensils'],
	['Groceries', 'shopping-basket'],
	['Transportation', 'car'],
	['Rent / Housing', 'house'],
	['Utilities', 'zap'],
	['Entertainment', 'clapperboard'],
	['Shopping', 'shopping-bag'],
	['Travel', 'plane'],
	['Health', 'heart-pulse'],
	['Other', 'shapes']
];
const EXPECTED_TRANSFER: ReadonlyArray<[string, string]> = [
	['Debt settlement', 'handshake'],
	['Cash', 'banknote'],
	['Bank transfer', 'landmark'],
	['Other', 'shapes']
];

describe('CATEGORIES constant', () => {
	it('has exactly 14 entries (10 spending + 4 transfer)', () => {
		expect(CATEGORIES).toHaveLength(14);
		expect(CATEGORIES.filter((c) => c.appliesTo === 'spending')).toHaveLength(10);
		expect(CATEGORIES.filter((c) => c.appliesTo === 'transfer')).toHaveLength(4);
	});

	it('has unique, stable-slug-shaped ids namespaced by applies_to', () => {
		const ids = CATEGORIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const c of CATEGORIES) {
			// `${appliesTo}-${slug}`: lowercase, kebab, prefixed by the applies_to set.
			expect(c.id).toMatch(/^[a-z]+(?:-[a-z]+)+$/);
			expect(c.id.startsWith(`${c.appliesTo}-`), `${c.id} should be namespaced`).toBe(true);
		}
	});

	it('keeps the two "Other" rows distinct (same name+icon, different id+applies_to)', () => {
		const others = CATEGORIES.filter((c) => c.name === 'Other');
		expect(others).toHaveLength(2);
		for (const o of others) {
			expect(o.icon).toBe('shapes');
		}
		expect(others.map((o) => o.id).sort()).toEqual(['spending-other', 'transfer-other']);
		expect(others.map((o) => o.appliesTo).sort()).toEqual(['spending', 'transfer']);
	});

	it('every entry has a non-empty name and a kebab-case lucide icon name', () => {
		for (const c of CATEGORIES) {
			expect(c.name.trim().length, `${c.id} name`).toBeGreaterThan(0);
			expect(c.icon, `${c.id} icon`).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
		}
	});

	it('only uses the applies_to value set {spending, transfer}', () => {
		for (const c of CATEGORIES) {
			expect(['spending', 'transfer']).toContain(c.appliesTo);
		}
	});

	it('matches the specced spending names → icons in table order', () => {
		const spending = categoriesFor('spending');
		expect(spending.map((c) => [c.name, c.icon])).toEqual(EXPECTED_SPENDING);
	});

	it('matches the specced transfer names → icons in table order', () => {
		const transfer = categoriesFor('transfer');
		expect(transfer.map((c) => [c.name, c.icon])).toEqual(EXPECTED_TRANSFER);
	});

	it('gives each applies_to set a 0-based contiguous sort_order sequence', () => {
		for (const set of ['spending', 'transfer'] as const) {
			const orders = CATEGORIES.filter((c) => c.appliesTo === set)
				.map((c) => c.sortOrder)
				.sort((a, b) => a - b);
			expect(orders, `${set} sort_order sequence`).toEqual(orders.map((_, i) => i));
		}
	});
});

describe('getCategory', () => {
	it('resolves a known id to itself (O(1) lookup parity)', () => {
		for (const c of CATEGORIES) {
			expect(getCategory(c.id)).toEqual(c);
		}
	});

	it('returns undefined for an unknown id', () => {
		expect(getCategory('spending-nope')).toBeUndefined();
		expect(getCategory('')).toBeUndefined();
	});
});

describe('categoriesFor', () => {
	it('returns only the matching applies_to set, ordered by sort_order', () => {
		const spending = categoriesFor('spending');
		expect(spending.every((c) => c.appliesTo === 'spending')).toBe(true);
		expect(spending.map((c) => c.sortOrder)).toEqual([...spending].map((_, i) => i));
	});
});

// Parity guard: the committed seed migration must INSERT one row per category in
// the constant with the matching id/name/icon/applies_to/sort_order, so the DB
// seed can never silently drift from the TS source of truth (PLAN §7.3).
describe('seed migration ↔ constant parity', () => {
	// Locate the migration carrying the `categories` seed by content (the filename
	// hash is drizzle-kit-generated and may change if the migration is regenerated).
	function readCategorySeedMigration(): string {
		const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
		const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql'));
		const matches = sqlFiles
			.map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
			.filter((sql) => /INSERT INTO "categories"/.test(sql));
		expect(matches, 'exactly one migration should seed categories').toHaveLength(1);
		return matches[0];
	}

	const sql = readCategorySeedMigration();

	it('is idempotent (ON CONFLICT upsert on id)', () => {
		expect(sql).toMatch(/ON CONFLICT \("id"\) DO UPDATE SET/);
	});

	it('contains an INSERT value row for every category in the constant', () => {
		for (const c of CATEGORIES) {
			// e.g. ('spending-food-drink', 'Food & Drink', 'utensils', 'spending', 0)
			const escName = c.name.replace(/'/g, "''");
			const row = `('${c.id}', '${escName}', '${c.icon}', '${c.appliesTo}', ${c.sortOrder})`;
			expect(sql, `missing seed row for ${c.id}`).toContain(row);
		}
	});

	it('seeds exactly 14 value rows (no extras)', () => {
		const valueRows = sql.match(/\(\s*'(?:spending|transfer)-[a-z-]+',/g) ?? [];
		expect(valueRows).toHaveLength(14);
	});
});

// Type-level guard: the constant satisfies the public interface (caught at build,
// asserted trivially here so the import is exercised).
describe('Category type', () => {
	it('is the element type of CATEGORIES', () => {
		const first: Category = CATEGORIES[0];
		expect(first.id).toBe('spending-food-drink');
	});
});
