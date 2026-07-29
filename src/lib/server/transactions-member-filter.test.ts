import { describe, it, expect, vi } from 'vitest';

// Unit tests for the "relates to this member" list filter (PLAN §10) — the SQL
// SHAPE of `memberInvolvementCondition`.
//
// WHY A SEPARATE FILE: `transactions.test.ts` mocks the schema modules with bare
// `{ __name }` tags so it can name inserts, which makes it structurally unable to
// RENDER any SQL. Here we mock ONLY `$lib/server/db` (so nothing tries to open a
// connection) and keep the REAL Drizzle tables, then render the fragment through
// `PgDialect` — the same dialect the app runs on. That turns "did we build the
// right predicate?" into a direct assertion instead of a guess.
//
// The SEMANTICS of the filter against real rows (a member who both paid and owes
// appears ONCE, a 0 share still counts, an id from another group matches nothing)
// belong to `tests/integration/transaction-member-filter.test.ts` — only a real
// Postgres can prove those.

vi.mock('$lib/server/db', () => ({ db: {} }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { memberInvolvementCondition } from './transactions';

const dialect = new PgDialect();

/** Render a fragment to `{ sql, params }` exactly as the driver would receive it. */
function render(fragment: ReturnType<typeof memberInvolvementCondition>) {
	if (!fragment) throw new Error('expected a SQL fragment');
	const query = dialect.sqlToQuery(fragment);
	return { sql: query.sql, params: query.params };
}

describe('memberInvolvementCondition (PLAN §10 member filter)', () => {
	it('returns undefined without a memberId — a bare role is ignored, not an error', () => {
		expect(memberInvolvementCondition(undefined)).toBeUndefined();
		expect(memberInvolvementCondition(undefined, 'paid')).toBeUndefined();
		expect(memberInvolvementCondition(undefined, 'owes')).toBeUndefined();
		// An empty string is "no filter", not "the member whose id is ''".
		expect(memberInvolvementCondition('')).toBeUndefined();
	});

	it("role 'paid' checks ONLY transaction_payers", () => {
		const { sql, params } = render(memberInvolvementCondition('m1', 'paid'));
		expect(sql).toContain('"transaction_payers"');
		expect(sql).not.toContain('"transaction_shares"');
		expect(params).toEqual(['m1']);
	});

	it("role 'owes' checks ONLY transaction_shares", () => {
		const { sql, params } = render(memberInvolvementCondition('m1', 'owes'));
		expect(sql).toContain('"transaction_shares"');
		expect(sql).not.toContain('"transaction_payers"');
		expect(params).toEqual(['m1']);
	});

	it('no role = EITHER side (the "relates to me" default), OR-ed', () => {
		const { sql, params } = render(memberInvolvementCondition('m1'));
		expect(sql).toContain('"transaction_payers"');
		expect(sql).toContain('"transaction_shares"');
		expect(sql).toContain(' or ');
		// The id is bound once per side — never interpolated into the SQL text.
		expect(params).toEqual(['m1', 'm1']);
		expect(sql).not.toContain('m1');
	});

	it('is a correlated EXISTS (a semi-join), never a join that could duplicate rows', () => {
		// The whole list contract depends on this: a JOIN against transaction_shares
		// would emit one row per beneficiary, silently breaking `limit` and the §16.4
		// keyset order. Assert the fragment is a correlated subquery on transactions.id.
		const { sql } = render(memberInvolvementCondition('m1'));
		expect(sql).toContain('exists (select 1 from');
		// Correlation: the subquery is tied to the OUTER transactions row.
		expect(sql).toContain('"transactions"."id"');
		expect(sql).not.toContain('join');
	});

	it('binds the member id as a parameter, so an id with SQL metacharacters is inert', () => {
		const hostile = "m1' or '1'='1";
		const { sql, params } = render(memberInvolvementCondition(hostile, 'paid'));
		expect(params).toEqual([hostile]);
		expect(sql).not.toContain(hostile);
	});
});
