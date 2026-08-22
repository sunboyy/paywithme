import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTableName, getTableColumns, type SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { groups, members, invites } from './groups-schema';
import * as schema from './schema';

// Import-level shape assertions for the domain tables added in task 3.1
// (PLAN §6, §9). No DB connection: we introspect the Drizzle table objects so an
// accidental rename, a wrong null/notNull, or a dropped index/constraint is
// caught at unit time. The partial-unique WHERE predicate that Drizzle can't
// cleanly round-trip here is verified by the generated SQL (see the migration).

describe('groups drizzle table', () => {
	it('maps to the `groups` SQL table', () => {
		expect(getTableName(groups)).toBe('groups');
	});

	it('exports exactly the expected columns', () => {
		const columns = getTableColumns(groups);
		expect(Object.keys(columns).sort()).toEqual([
			'createdAt',
			'createdBy',
			'deletedAt',
			'id',
			'name',
			// The rounding-rotation allocator's counter (ADR-0013) — storage only; the
			// `Group` domain type deliberately omits it so it can't reach an API payload.
			'nextRoundingSeq',
			'settlementCurrency'
		]);
	});

	it('maps property keys to snake_case columns with the right nullability', () => {
		const c = getTableColumns(groups);

		expect(c.id.name).toBe('id');
		expect(c.id.primary).toBe(true);

		expect(c.name.name).toBe('name');
		expect(c.name.notNull).toBe(true);

		// settlement currency is a required code (locking is a later concern).
		expect(c.settlementCurrency.name).toBe('settlement_currency');
		expect(c.settlementCurrency.notNull).toBe(true);

		// authorship is durable: created_by required.
		expect(c.createdBy.name).toBe('created_by');
		expect(c.createdBy.notNull).toBe(true);

		expect(c.createdAt.name).toBe('created_at');
		expect(c.createdAt.notNull).toBe(true);
		expect(c.createdAt.hasDefault).toBe(true);

		// soft-delete: nullable.
		expect(c.deletedAt.name).toBe('deleted_at');
		expect(c.deletedAt.notNull).toBe(false);
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).groups).toBe(groups);
	});
});

describe('members drizzle table', () => {
	it('maps to the `members` SQL table', () => {
		expect(getTableName(members)).toBe('members');
	});

	it('exports exactly the expected columns', () => {
		const columns = getTableColumns(members);
		expect(Object.keys(columns).sort()).toEqual([
			'deactivatedAt',
			'displayName',
			'groupId',
			'id',
			// The app-computed canonical form of `displayName` (ADR-0015) — storage for
			// the active-name uniqueness index only; no view projects it.
			'normalizedDisplayName',
			'userId'
		]);
	});

	it('maps property keys to snake_case columns with the right nullability', () => {
		const c = getTableColumns(members);

		expect(c.id.primary).toBe(true);

		expect(c.groupId.name).toBe('group_id');
		expect(c.groupId.notNull).toBe(true);

		// display_name is required (§6.2).
		expect(c.displayName.name).toBe('display_name');
		expect(c.displayName.notNull).toBe(true);

		// …and so is its canonical form: the uniqueness index has nothing to compare
		// if a row may carry a NULL key (ADR-0015).
		expect(c.normalizedDisplayName.name).toBe('normalized_display_name');
		expect(c.normalizedDisplayName.notNull).toBe(true);
		// NOT defaulted and NOT DB-generated: it is written by
		// `displayNameValues()` on every name write, so a missing value is a loud
		// not-null violation rather than a silently wrong key.
		expect(c.normalizedDisplayName.hasDefault).toBe(false);

		// user link is nullable (unlinked slots are valid).
		expect(c.userId.name).toBe('user_id');
		expect(c.userId.notNull).toBe(false);

		// soft-deactivate: nullable.
		expect(c.deactivatedAt.name).toBe('deactivated_at');
		expect(c.deactivatedAt.notNull).toBe(false);
	});

	it('indexes group_id and user_id', () => {
		const { indexes } = getTableConfig(members);
		const names = indexes.map((i) => i.config.name).sort();
		expect(names).toContain('members_group_id_idx');
		expect(names).toContain('members_user_id_idx');
	});

	it('declares the partial unique index over (group_id, user_id)', () => {
		const { indexes } = getTableConfig(members);
		const uniq = indexes.find((i) => i.config.name === 'members_group_id_user_id_unique');
		expect(uniq).toBeDefined();
		expect(uniq?.config.unique).toBe(true);

		// Composite over both columns.
		const cols = (uniq?.config.columns ?? []).map((col) => (col as { name?: string }).name).sort();
		expect(cols).toEqual(['group_id', 'user_id']);

		// Partial predicate present: the index is constrained to non-null user_id
		// so multiple unlinked members per group remain allowed. We render the
		// WHERE SQL via the Pg dialect (the raw chunk holds a circular table ref)
		// and assert it is `"user_id" IS NOT NULL`. The exact form is also asserted
		// against the generated migration's `.sql`.
		const where = uniq?.config.where as SQL | undefined;
		expect(where).toBeDefined();
		const rendered = new PgDialect().sqlToQuery(where!).sql.toLowerCase();
		expect(rendered).toContain('"user_id" is not null');
	});

	it('declares the ACTIVE-only unique index over (group_id, normalized_display_name)', () => {
		const { indexes } = getTableConfig(members);
		const uniq = indexes.find(
			(i) => i.config.name === 'members_group_id_normalized_display_name_unique'
		);
		expect(uniq).toBeDefined();
		expect(uniq?.config.unique).toBe(true);

		// Scoped PER GROUP, and compared on the NORMALIZED column — not on
		// `display_name`, which would miss a case/whitespace-only collision (ADR-0015).
		const cols = (uniq?.config.columns ?? []).map((col) => (col as { name?: string }).name);
		expect(cols).toEqual(['group_id', 'normalized_display_name']);

		// The PARTIAL predicate is the whole point: deactivated members are exempt, so
		// their name is reusable and renaming them is never blocked (§6.3). Rendered via
		// the Pg dialect for the same reason as the index above.
		const where = uniq?.config.where as SQL | undefined;
		expect(where).toBeDefined();
		const rendered = new PgDialect().sqlToQuery(where!).sql.toLowerCase();
		expect(rendered).toContain('"deactivated_at" is null');
		// Guard against the predicate flipping to the wrong flag/sense: `IS NOT NULL`
		// would constrain exactly the rows that must stay free.
		expect(rendered).not.toContain('is not null');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).members).toBe(members);
	});
});

// Guard the HAND-EDITED uniqueness migration (issue #75; ADR-0015). `drizzle-kit
// generate` emits a single `ADD COLUMN "normalized_display_name" text NOT NULL`,
// which cannot run against a table that already holds members; the committed
// migration splits it into add-nullable → backfill → set-not-null. If someone
// regenerates it and loses the backfill, `pnpm db:migrate` breaks on every existing
// database — so assert the shape here, where the fast gate sees it (the real-DB
// assertions live in `tests/integration/member-name-uniqueness.test.ts`).
describe('member-name uniqueness migration', () => {
	function readUniquenessMigration(): string {
		const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../drizzle');
		const matches = readdirSync(drizzleDir)
			.filter((f) => f.endsWith('.sql'))
			.map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
			.filter((sql) => /ADD COLUMN "normalized_display_name"/.test(sql));
		expect(matches, 'exactly one migration should add normalized_display_name').toHaveLength(1);
		return matches[0];
	}

	const sql = readUniquenessMigration();

	it('adds `normalized_display_name` NULLABLE, then backfills, then sets NOT NULL', () => {
		const addIdx = sql.indexOf('ADD COLUMN "normalized_display_name" text;');
		const backfillIdx = sql.search(/UPDATE "members" SET "normalized_display_name" =/);
		const notNullIdx = sql.indexOf('ALTER COLUMN "normalized_display_name" SET NOT NULL');

		expect(addIdx, 'the column must be added NULLABLE').toBeGreaterThan(-1);
		expect(backfillIdx, 'existing rows must be backfilled').toBeGreaterThan(addIdx);
		expect(notNullIdx, 'the column must end up NOT NULL').toBeGreaterThan(backfillIdx);
		// The generated `ADD COLUMN ... NOT NULL` one-liner must NOT be present.
		expect(sql).not.toContain('ADD COLUMN "normalized_display_name" text NOT NULL');
	});

	it('backfills with the SAME rule the app applies (NFC → trim → lowercase)', () => {
		// Drop any of the three and pre-existing rows carry a key the app would never
		// have written, which silently lets a duplicate through: the index compares
		// stored keys, so two rows whose keys differ are "different names" to Postgres.
		expect(sql).toContain('lower(btrim(normalize("display_name", NFC)))');
	});

	it('creates the unique index PARTIAL on active members only', () => {
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "members_group_id_normalized_display_name_unique" ON "members"[\s\S]*"group_id","normalized_display_name"/
		);
		// Without the WHERE clause this would be a plain unique index that also
		// constrains deactivated rows — burning a departed member's name for the group
		// and blocking the rename that ADR-0015 relies on as the escape hatch.
		expect(sql).toMatch(/WHERE "members"\."deactivated_at" is null/i);
	});
});

describe('invites drizzle table', () => {
	it('maps to the `invites` SQL table', () => {
		expect(getTableName(invites)).toBe('invites');
	});

	it('exports exactly the expected columns', () => {
		const columns = getTableColumns(invites);
		expect(Object.keys(columns).sort()).toEqual([
			'createdAt',
			'createdBy',
			'expiresAt',
			'groupId',
			'id',
			'revokedAt',
			'token'
		]);
	});

	it('maps property keys to snake_case columns with the right nullability', () => {
		const c = getTableColumns(invites);

		expect(c.id.primary).toBe(true);

		expect(c.groupId.name).toBe('group_id');
		expect(c.groupId.notNull).toBe(true);

		// token: required + unique lookup.
		expect(c.token.name).toBe('token');
		expect(c.token.notNull).toBe(true);
		expect(c.token.isUnique).toBe(true);

		// MEMBER-AGNOSTIC (§6.2): there is no `member_id` column on invites at all.
		expect(c).not.toHaveProperty('memberId');

		// expiry required (the 7-day window).
		expect(c.expiresAt.name).toBe('expires_at');
		expect(c.expiresAt.notNull).toBe(true);

		// revoke: nullable.
		expect(c.revokedAt.name).toBe('revoked_at');
		expect(c.revokedAt.notNull).toBe(false);

		expect(c.createdBy.name).toBe('created_by');
		expect(c.createdBy.notNull).toBe(true);

		expect(c.createdAt.name).toBe('created_at');
		expect(c.createdAt.notNull).toBe(true);
		expect(c.createdAt.hasDefault).toBe(true);
	});

	it('indexes group_id and token', () => {
		const { indexes } = getTableConfig(invites);
		const names = indexes.map((i) => i.config.name).sort();
		expect(names).toContain('invites_group_id_idx');
		expect(names).toContain('invites_token_idx');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).invites).toBe(invites);
	});
});
