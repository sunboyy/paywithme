import { describe, it, expect } from 'vitest';
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

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).members).toBe(members);
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
			'memberId',
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

		// member_id targets a slot: nullable (open invite has none).
		expect(c.memberId.name).toBe('member_id');
		expect(c.memberId.notNull).toBe(false);

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
