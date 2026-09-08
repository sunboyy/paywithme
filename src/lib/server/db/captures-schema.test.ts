import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { captures } from './captures-schema';
import * as schema from './schema';

// Import-level shape assertions for `captures` (issue #49; PLAN §7.7, §9;
// ADR-0012). No DB connection: we introspect the Drizzle table object, so a
// rename, a wrong nullability, a flipped `onDelete` — or, most importantly, a
// LEDGER-SHAPED COLUMN sneaking in — is caught at unit time. The real-database
// guarantees (the cascade firing, the partial index actually serving the count)
// live in `tests/integration/capture-service.test.ts`.

describe('captures drizzle table', () => {
	it('maps to the `captures` SQL table', () => {
		expect(getTableName(captures)).toBe('captures');
	});

	it('exports EXACTLY the columns PLAN §9 lists — no more', () => {
		expect(Object.keys(getTableColumns(captures)).sort()).toEqual([
			'amountMinor',
			'capturedFor',
			'createdAt',
			'createdBy',
			'currency',
			'discardedAt',
			'groupId',
			'id',
			'note',
			'resolvedAt',
			'resolvedTransactionId'
		]);
	});

	it('has NO payer / beneficiary / split / item / rate column (ADR-0012)', () => {
		// The shallowness IS the spec. A Capture that can hold structured splits is a
		// second transaction form — reject any addition of one of these.
		const c = getTableColumns(captures) as Record<string, unknown>;
		for (const forbidden of [
			'payerId',
			'payers',
			'beneficiaries',
			'memberId',
			'splitMode',
			'items',
			'exchangeRate',
			'amountMinorSettlement',
			'amountTotalSettlement',
			'categoryId',
			'type'
		]) {
			expect(c, `captures must not have a \`${forbidden}\` column`).not.toHaveProperty(forbidden);
		}
	});

	it('maps property keys to snake_case columns with the right nullability', () => {
		const c = getTableColumns(captures);

		expect(c.id.name).toBe('id');
		expect(c.id.primary).toBe(true);
		expect(typeof c.id.defaultFn).toBe('function');
		expect(c.id.defaultFn?.()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);

		// A Capture REQUIRES a group and an author (§7.7 "Edge cases" / "Group-visible").
		expect(c.groupId.name).toBe('group_id');
		expect(c.groupId.notNull).toBe(true);
		expect(c.createdBy.name).toBe('created_by');
		expect(c.createdBy.notNull).toBe(true);

		// The only required content.
		expect(c.note.name).toBe('note');
		expect(c.note.notNull).toBe(true);

		// Money: integer minor units in a bigint, NEVER a float (CLAUDE.md). Optional.
		expect(c.amountMinor.name).toBe('amount_minor');
		expect(c.amountMinor.columnType).toBe('PgBigInt53');
		expect(c.amountMinor.notNull).toBe(false);

		// Optional, and paired with the amount by the Zod schema, not by the DB.
		expect(c.currency.name).toBe('currency');
		expect(c.currency.notNull).toBe(false);

		// The real-world day: a DATE, not a timestamp.
		expect(c.capturedFor.name).toBe('captured_for');
		expect(c.capturedFor.columnType).toBe('PgDateString');
		expect(c.capturedFor.notNull).toBe(true);
		expect(c.capturedFor.hasDefault).toBe(true);

		// Both endings are nullable STAMPS — a Capture is never hard-deleted.
		expect(c.resolvedTransactionId.name).toBe('resolved_transaction_id');
		expect(c.resolvedTransactionId.notNull).toBe(false);
		expect(c.resolvedAt.name).toBe('resolved_at');
		expect(c.resolvedAt.notNull).toBe(false);
		expect(c.discardedAt.name).toBe('discarded_at');
		expect(c.discardedAt.notNull).toBe(false);

		// The plain server insert time — see below.
		expect(c.createdAt.name).toBe('created_at');
		expect(c.createdAt.notNull).toBe(true);
		expect(c.createdAt.hasDefault).toBe(true);
	});

	it('does NOT repeat §7.1’s created_at/occurred_at reversal', () => {
		// On `transactions`, `created_at` is the editable real-world date. Here the
		// real-world day has its own column (`captured_for`), so `created_at` is the
		// plain insert time and there is no `occurred_at` at all (PLAN §9).
		expect(getTableColumns(captures)).not.toHaveProperty('occurredAt');
	});

	it('cascades from `groups`, restricts on `user`, and NULLS the ledger link', () => {
		const { foreignKeys } = getTableConfig(captures);
		const byColumn = new Map(
			foreignKeys.map((fk) => [fk.reference().columns[0].name, fk] as const)
		);
		expect([...byColumn.keys()].sort()).toEqual([
			'created_by',
			'group_id',
			'resolved_transaction_id'
		]);

		// The group owns its Captures.
		expect(byColumn.get('group_id')!.onDelete).toBe('cascade');
		// Authorship is durable: no ON DELETE clause, like `transactions.created_by` —
		// Postgres NO ACTION refuses to delete a user who authored a Capture.
		expect(byColumn.get('created_by')!.onDelete).toBe('no action');
		expect(getTableName(byColumn.get('created_by')!.reference().foreignTable)).toBe('user');
		// A hard-deleted transaction must not drag the Capture down with it: the row
		// stays RESOLVED (`resolved_at` still set) with a dangling link.
		expect(byColumn.get('resolved_transaction_id')!.onDelete).toBe('set null');
		expect(getTableName(byColumn.get('resolved_transaction_id')!.reference().foreignTable)).toBe(
			'transactions'
		);
	});

	it('has NO foreign key on `currency` (the ledger must not bend around a Capture)', () => {
		const { foreignKeys } = getTableConfig(captures);
		expect(foreignKeys.some((fk) => fk.reference().columns[0].name === 'currency')).toBe(false);
	});

	it('indexes (group_id, resolved_at) plus the two PARTIAL indexes "open" needs', () => {
		const { indexes } = getTableConfig(captures);
		// SET EQUALITY, by name: an index that appears without a reason, or one that
		// quietly disappears, is a query plan changing behind the count's back.
		expect(indexes.map((i) => i.config.name).sort()).toEqual([
			'captures_group_id_open_idx',
			'captures_group_id_resolved_at_idx',
			'captures_resolved_transaction_id_idx'
		]);

		const listing = indexes.find((i) => i.config.name === 'captures_group_id_resolved_at_idx');
		expect(listing, 'PLAN §9 names this index').toBeDefined();
		expect(listing!.config.columns.map((col) => (col as { name?: string }).name)).toEqual([
			'group_id',
			'resolved_at'
		]);
		expect(listing!.config.where).toBeUndefined();

		// ARM 1 of "open" (PLAN §9: a partial index on open rows for the count).
		const open = indexes.find((i) => i.config.name === 'captures_group_id_open_idx');
		expect(open, 'PLAN §9: a partial index on open rows for the count').toBeDefined();
		expect(open!.config.columns.map((col) => (col as { name?: string }).name)).toEqual([
			'group_id'
		]);
		// PARTIAL is the whole point — the resolved history grows forever, the open set
		// is a queue to empty.
		expect(open!.config.where).toBeDefined();

		// ARM 2's half on this side (issue #91): given a soft-deleted transaction, find
		// the note pointing at it. Partial on the link being set, so the unresolved rows
		// — most of the table, and all of the open queue — are not in it.
		const link = indexes.find((i) => i.config.name === 'captures_resolved_transaction_id_idx');
		expect(link, 'issue #91: the re-open arm probes this index').toBeDefined();
		expect(link!.config.columns.map((col) => (col as { name?: string }).name)).toEqual([
			'resolved_transaction_id'
		]);
		expect(link!.config.where).toBeDefined();
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).captures).toBe(captures);
	});
});

// Guard the migration's SQL text, where the fast gate can see it.
describe('captures migration', () => {
	function readMigration(): string {
		const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');
		const matches = readdirSync(drizzleDir)
			.filter((f) => f.endsWith('.sql'))
			.map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
			.filter((sql) => /CREATE TABLE "captures"/.test(sql));
		expect(matches, 'exactly one migration should create captures').toHaveLength(1);
		return matches[0];
	}

	const sql = readMigration();
	// The header prose talks ABOUT the choices below (and says "real-world"), so the
	// type/keyword assertions run against the DDL alone.
	const ddl = sql
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('--'))
		.join('\n');

	it('creates the money column as a bigint and the date as a date', () => {
		expect(ddl).toMatch(/"amount_minor" bigint,/);
		expect(ddl).toMatch(/"currency" text,/);
		expect(ddl).toMatch(/"captured_for" date DEFAULT now\(\) NOT NULL/);
		expect(ddl).toMatch(/"created_at" timestamp DEFAULT now\(\) NOT NULL/);
		// No float type ever touches money (CLAUDE.md).
		expect(ddl).not.toMatch(/\b(real|double precision|float)\b/);
	});

	it('creates NO ledger-shaped column', () => {
		for (const forbidden of [
			'payer',
			'beneficiar',
			'split_mode',
			'exchange_rate',
			'settlement',
			'category_id'
		]) {
			expect(ddl, `captures must not have a ${forbidden} column`).not.toMatch(
				new RegExp(`"[a-z_]*${forbidden}[a-z_]*"\\s+(text|bigint|integer|numeric|date|timestamp)`)
			);
		}
	});

	it('does not FK the currency, and nulls the transaction link on delete', () => {
		expect(ddl).not.toMatch(/FOREIGN KEY \("currency"\)/);
		expect(ddl).toMatch(
			/FOREIGN KEY \("resolved_transaction_id"\) REFERENCES "public"\."transactions"\("id"\) ON DELETE set null/
		);
		expect(ddl).toMatch(
			/FOREIGN KEY \("group_id"\) REFERENCES "public"\."groups"\("id"\) ON DELETE cascade/
		);
	});

	it('creates the partial open-rows index over BOTH null stamps', () => {
		expect(ddl).toMatch(
			/CREATE INDEX "captures_group_id_open_idx" ON "captures" USING btree \("group_id"\) WHERE .*resolved_at" is null and .*discarded_at" is null/
		);
	});
});

// The RE-OPEN migration (issue #91) — the second half of "open", which no partial
// index can hold on its own because the fact lives in `transactions`.
describe('capture re-open migration', () => {
	function readMigration(): string {
		const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');
		const matches = readdirSync(drizzleDir)
			.filter((f) => f.endsWith('.sql'))
			.map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
			.filter((sql) => /CREATE INDEX "captures_resolved_transaction_id_idx"/.test(sql));
		expect(matches, 'exactly one migration should create the re-open indexes').toHaveLength(1);
		return matches[0];
	}

	const ddl = readMigration()
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('--'))
		.join('\n');

	it('creates BOTH partial indexes the re-open arm is driven by', () => {
		// A group's soft-deleted transactions — the small set the arm starts from.
		expect(ddl).toMatch(
			/CREATE INDEX "transactions_group_id_deleted_idx" ON "transactions" USING btree \("group_id"\) WHERE .*deleted_at" is not null/
		);
		// ...and the note that points at each one.
		expect(ddl).toMatch(
			/CREATE INDEX "captures_resolved_transaction_id_idx" ON "captures" USING btree \("resolved_transaction_id"\) WHERE .*resolved_transaction_id" is not null/
		);
	});

	it('adds NO column and clears NO stamp — re-opening is a read-time rule (§7.7)', () => {
		// "Resolve is a stamp, not a delete": the trail from remembering to recording
		// survives, so nothing here writes to `captures` or widens it.
		expect(ddl).not.toMatch(/ALTER TABLE "captures"/);
		expect(ddl).not.toMatch(/\bUPDATE\b/i);
	});
});
