import { describe, it, expect, beforeEach, vi } from 'vitest';

// Unit tests for the group activity-feed read (task 6.2; PLAN §12.1). STRATEGY
// mirrors `balances.test.ts`: NO real DB — a fluent query-builder stub whose
// successive SELECT chains resolve to programmed row-sets in order:
//   1) access check (userHasGroupAccess) → membership rows
//   2) the activity rows (audit_log ⋈ members ⋈ user, this group, occurred_at DESC)
// We also CAPTURE the args the chain methods receive (where/orderBy/limit) so we can
// assert the group scope, the optional filters, the DESC sort and the limit are
// actually applied — without a real DB.

const { selectQueue, calls, makeDb } = vi.hoisted(() => {
	const selectQueue: unknown[][] = [];
	const calls: {
		where: unknown[][];
		orderBy: unknown[][];
		limit: unknown[][];
		leftJoin: unknown[][];
	} = {
		where: [],
		orderBy: [],
		limit: [],
		leftJoin: []
	};

	function nextRows(): unknown[] {
		return selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
	}

	function selectChain() {
		const rows = nextRows();
		// Only the ACTIVITY query uses leftJoin; the access-check query (which also
		// runs through this stub) does not. We capture where/orderBy/limit ONLY for the
		// chain that left-joined, so the access query's own where/limit don't pollute
		// the assertions.
		let isActivityQuery = false;
		const chain: Record<string, unknown> = {};
		chain.from = () => chain;
		chain.innerJoin = () => chain;
		chain.leftJoin = (...a: unknown[]) => {
			isActivityQuery = true;
			calls.leftJoin.push(a);
			return chain;
		};
		chain.where = (...a: unknown[]) => {
			if (isActivityQuery) calls.where.push(a);
			return chain;
		};
		chain.orderBy = (...a: unknown[]) => {
			if (isActivityQuery) calls.orderBy.push(a);
			return chain;
		};
		chain.limit = (...a: unknown[]) => {
			if (isActivityQuery) calls.limit.push(a);
			return chain;
		};
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	const db = { select: () => selectChain() };
	return { selectQueue, calls, makeDb: () => db };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));
// drizzle helpers — capture the operands so where/orderBy assertions are meaningful.
vi.mock('drizzle-orm', () => ({
	and: (...c: unknown[]) => ({ op: 'and', c }),
	eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
	desc: (a: unknown) => ({ op: 'desc', a }),
	// Used by the REAL userHasGroupAccess (groups.ts) which runs through the stub.
	isNull: (a: unknown) => ({ op: 'isNull', a })
}));
vi.mock('$lib/server/db/audit-schema', () => {
	const col = (name: string) => ({ __col: name });
	return {
		auditLog: {
			id: col('id'),
			action: col('action'),
			entityType: col('entity_type'),
			entityId: col('entity_id'),
			summary: col('summary'),
			metadata: col('metadata'),
			occurredAt: col('occurred_at'),
			actorUserId: col('actor_user_id'),
			groupId: col('group_id')
		}
	};
});
vi.mock('$lib/server/db/groups-schema', () => ({
	members: {
		id: { __col: 'm_id' },
		displayName: { __col: 'display_name' },
		userId: { __col: 'user_id' },
		groupId: { __col: 'm_group_id' },
		deactivatedAt: { __col: 'deactivated_at' }
	},
	// Referenced by the REAL userHasGroupAccess (groups.ts) access check.
	groups: { id: { __col: 'g_id' }, deletedAt: { __col: 'g_deleted_at' } }
}));
vi.mock('$lib/server/db/auth-schema', () => ({
	user: { id: { __col: 'u_id' }, name: { __col: 'u_name' } }
}));

import { listGroupActivity, parseEntityTypeFilter, ACTIVITY_LIMIT } from './activity';
import { GroupAccessError } from './groups';

function queueSelects(...rowSets: unknown[][]) {
	selectQueue.length = 0;
	selectQueue.push(...rowSets);
}

const ACCESS_OK = [{ id: 'access-member' }];
const OCCURRED = new Date('2026-06-15T10:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
	return {
		id: 'a1',
		action: 'create',
		entityType: 'transaction',
		entityId: 't1',
		summary: 'Created Dinner',
		metadata: null,
		occurredAt: OCCURRED,
		actorUserId: 'u1',
		memberName: 'Alice (member)',
		userName: 'Alice User',
		...over
	};
}

beforeEach(() => {
	selectQueue.length = 0;
	calls.where.length = 0;
	calls.orderBy.length = 0;
	calls.limit.length = 0;
	calls.leftJoin.length = 0;
});

describe('parseEntityTypeFilter', () => {
	it('keeps a recognized entity type', () => {
		expect(parseEntityTypeFilter('transaction')).toBe('transaction');
		expect(parseEntityTypeFilter('member')).toBe('member');
		expect(parseEntityTypeFilter('invite')).toBe('invite');
		expect(parseEntityTypeFilter('group')).toBe('group');
	});
	it('ignores unrecognized / null values', () => {
		expect(parseEntityTypeFilter('junk')).toBeUndefined();
		expect(parseEntityTypeFilter('')).toBeUndefined();
		expect(parseEntityTypeFilter(null)).toBeUndefined();
		expect(parseEntityTypeFilter(undefined)).toBeUndefined();
	});
});

describe('listGroupActivity (PLAN §12.1)', () => {
	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]); // access check finds nothing
		await expect(listGroupActivity({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('returns rows newest-first with occurredAt stringified and actor resolved to member name', async () => {
		queueSelects(ACCESS_OK, [row()]);
		const result = await listGroupActivity({ userId: 'u1', groupId: 'g1' });
		expect(result).toEqual([
			{
				id: 'a1',
				action: 'create',
				entityType: 'transaction',
				entityId: 't1',
				summary: 'Created Dinner',
				metadata: null,
				occurredAt: '2026-06-15T10:00:00.000Z',
				actorUserId: 'u1',
				actorName: 'Alice (member)'
			}
		]);
		// occurred_at DESC sort applied (newest first).
		expect(calls.orderBy[0][0]).toEqual({ op: 'desc', a: { __col: 'occurred_at' } });
	});

	it('falls back to the user name when there is no member slot in this group', async () => {
		queueSelects(ACCESS_OK, [row({ memberName: null })]);
		const [r] = await listGroupActivity({ userId: 'u1', groupId: 'g1' });
		expect(r.actorName).toBe('Alice User');
	});

	it('falls back to "Someone" when even the user name is null (never crash)', async () => {
		queueSelects(ACCESS_OK, [row({ memberName: null, userName: null })]);
		const [r] = await listGroupActivity({ userId: 'u1', groupId: 'g1' });
		expect(r.actorName).toBe('Someone');
	});

	it('scopes to the group and applies the entityType + actor filters', async () => {
		queueSelects(ACCESS_OK, [row()]);
		await listGroupActivity({
			userId: 'u1',
			groupId: 'g1',
			filters: { entityType: 'member', actorUserId: 'u9' }
		});
		// The single where() receives an `and(...)` of group scope + both filters.
		const whereArg = calls.where[0][0] as { op: string; c: unknown[] };
		expect(whereArg.op).toBe('and');
		expect(whereArg.c).toContainEqual({ op: 'eq', a: { __col: 'group_id' }, b: 'g1' });
		expect(whereArg.c).toContainEqual({ op: 'eq', a: { __col: 'entity_type' }, b: 'member' });
		expect(whereArg.c).toContainEqual({ op: 'eq', a: { __col: 'actor_user_id' }, b: 'u9' });
	});

	it('applies only the group scope when no filters are given', async () => {
		queueSelects(ACCESS_OK, [row()]);
		await listGroupActivity({ userId: 'u1', groupId: 'g1' });
		const whereArg = calls.where[0][0] as { op: string; c: unknown[] };
		expect(whereArg.c).toHaveLength(1);
		expect(whereArg.c[0]).toEqual({ op: 'eq', a: { __col: 'group_id' }, b: 'g1' });
	});

	it('applies the ACTIVITY_LIMIT cap', async () => {
		queueSelects(ACCESS_OK, [row()]);
		await listGroupActivity({ userId: 'u1', groupId: 'g1' });
		expect(calls.limit[0][0]).toBe(ACTIVITY_LIMIT);
	});
});
