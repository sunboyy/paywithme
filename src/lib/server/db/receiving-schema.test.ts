import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { receivingMethod } from './receiving-schema';
import * as schema from './schema';

// Import-level shape assertions for `receiving_method` (issue #83; PLAN §17.1,
// §17.2, §17.6; ADR-0016). No DB connection: we introspect the Drizzle table
// object, so an accidental rename, a wrong nullability, a flipped `onDelete`, or a
// unique constraint sneaking onto the position index is caught at unit time. The
// real-database guarantees (the cascade actually firing, duplicate positions
// actually inserting) live in `tests/integration/receiving-method-schema.test.ts`.

describe('receivingMethod drizzle table', () => {
	it('maps to the `receiving_method` SQL table', () => {
		// Singular, as PLAN §17.6 spells it.
		expect(getTableName(receivingMethod)).toBe('receiving_method');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(receivingMethod)).sort()).toEqual([
			'createdAt',
			'details',
			'id',
			'position',
			'rail',
			'userId'
		]);
	});

	it('maps property keys to snake_case columns with the right nullability', () => {
		const c = getTableColumns(receivingMethod);

		expect(c.id.name).toBe('id');
		expect(c.id.primary).toBe(true);
		// In-app generated UUID, like every other text PK here.
		expect(c.id.hasDefault).toBe(true);
		expect(typeof c.id.defaultFn).toBe('function');
		expect(c.id.defaultFn?.()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);

		// A method always has an owner (§17.1: it belongs to a user).
		expect(c.userId.name).toBe('user_id');
		expect(c.userId.notNull).toBe(true);

		// The registry key: plain TEXT, so adding a rail needs no migration (§17.2).
		expect(c.rail.name).toBe('rail');
		expect(c.rail.notNull).toBe(true);
		expect(c.rail.columnType).toBe('PgText');
		// No enum, and no `check`-style value list at the DB level.
		expect(c.rail.enumValues).toBeUndefined();

		// The rail's fields — jsonb, shape unknown to the database (ADR-0016).
		expect(c.details.name).toBe('details');
		expect(c.details.notNull).toBe(true);
		expect(c.details.columnType).toBe('PgJsonb');

		// Ordering within the profile; first = preferred, so it is always present.
		expect(c.position.name).toBe('position');
		expect(c.position.notNull).toBe(true);
		expect(c.position.columnType).toBe('PgInteger');
		// No DB default: the service decides where a new method lands in the order.
		expect(c.position.hasDefault).toBe(false);

		expect(c.createdAt.name).toBe('created_at');
		expect(c.createdAt.notNull).toBe(true);
		expect(c.createdAt.hasDefault).toBe(true);
	});

	it('has NO is_default / preferred flag — the ORDER is the preference (§17.1)', () => {
		const c = getTableColumns(receivingMethod);
		expect(c).not.toHaveProperty('isDefault');
		expect(c).not.toHaveProperty('preferred');
	});

	it('cascades from `user`, unlike `members.user_id` (§17.6)', () => {
		const { foreignKeys } = getTableConfig(receivingMethod);
		expect(foreignKeys).toHaveLength(1);
		const fk = foreignKeys[0];
		expect(fk.reference().columns.map((col) => col.name)).toEqual(['user_id']);
		expect(getTableName(fk.reference().foreignTable)).toBe('user');
		// A member slot carries ledger history worth preserving (`set null`); a
		// receiving method carries none — when the user goes, it goes.
		expect(fk.onDelete).toBe('cascade');
	});

	it('indexes (user_id, position) — PLAIN, not unique', () => {
		const { indexes } = getTableConfig(receivingMethod);
		expect(indexes).toHaveLength(1);
		const idx = indexes[0];
		expect(idx.config.name).toBe('receiving_method_user_id_position_idx');
		expect(idx.config.columns.map((col) => (col as { name?: string }).name)).toEqual([
			'user_id',
			'position'
		]);
		// UNIQUE here would turn every reorder into a temp-value dance for no
		// benefit: duplicate positions are an ambiguous order, not corrupt data.
		expect(idx.config.unique).toBe(false);
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).receivingMethod).toBe(receivingMethod);
	});
});

// Guard the migration's SQL text, where the fast gate can see it (the real-DB
// assertions need a database and live in the integration suite).
describe('receiving_method migration', () => {
	function readMigration(): string {
		const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');
		const matches = readdirSync(drizzleDir)
			.filter((f) => f.endsWith('.sql'))
			.map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
			.filter((sql) => /CREATE TABLE "receiving_method"/.test(sql));
		expect(matches, 'exactly one migration should create receiving_method').toHaveLength(1);
		return matches[0];
	}

	const sql = readMigration();

	it('creates the table with a jsonb `details` and a text `rail`', () => {
		expect(sql).toMatch(/"rail" text NOT NULL/);
		expect(sql).toMatch(/"details" jsonb NOT NULL/);
		expect(sql).toMatch(/"position" integer NOT NULL/);
		expect(sql).toMatch(/"created_at" timestamp DEFAULT now\(\) NOT NULL/);
	});

	it('teaches the database NOTHING about the shape of `details` or `rail`', () => {
		// A CHECK constraint or an enum type here is what ADR-0016 rejects: adding a
		// country must stay a code change, with no migration and no touching rows.
		// Case-sensitive: the migration's own header prose talks *about* check
		// constraints, and only real SQL keywords are uppercase.
		expect(sql).not.toMatch(/\bCHECK\b/);
		expect(sql).not.toMatch(/CREATE TYPE/);
	});

	it('references user with ON DELETE cascade', () => {
		expect(sql).toMatch(/REFERENCES "public"\."user"\("id"\) ON DELETE cascade/);
	});

	it('creates the (user_id, position) index WITHOUT unique', () => {
		expect(sql).toMatch(
			/CREATE INDEX "receiving_method_user_id_position_idx" ON "receiving_method" USING btree \("user_id","position"\)/
		);
		expect(sql).not.toMatch(/CREATE UNIQUE INDEX "receiving_method/);
	});
});
