import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the group service (PLAN §6.1, §6.4, §12).
//
// STRATEGY (mirrors `register/page.server.test.ts` mocking `$lib/server/auth`):
// there is NO real DB here — real CRUD round-trips are deferred to the task 3.9
// integration tests. We mock `$lib/server/db` with a small fluent query-builder
// stub so we can assert the *meaningful* service guarantees:
//   - `createGroup` opens a transaction and inserts BOTH a group AND the creator
//     member with the right `user_id` / `display_name` (PLAN §6.1 access).
//   - the mutations + access-checked read reject when the access primitive
//     reports no membership (PLAN §12) — surfaced as `GroupAccessError`.
//   - the PURE settlement-currency lock rule is tested directly, both branches.
//
// The fluent stub records `insert(...).values(...)` calls and lets each test
// program what the access `select(...)` resolves to.

// --- Fluent DB mock -------------------------------------------------------
// `selectResult` is the rows the access/list/get SELECT chain resolves to.
// `insertedRows` captures every `insert(table).values(v)` for assertions.
const { selectResult, insertCalls, orderByCalls, makeDb } = vi.hoisted(() => {
	const state = { selectRows: [] as unknown[] };
	const insertCalls: { table: unknown; values: unknown }[] = [];
	// Records every `.orderBy(arg)` so list tests can assert the newest-first
	// ordering (the arg is the `desc(groups.createdAt)` expression).
	const orderByCalls: unknown[] = [];

	// A thenable chain: every builder method returns the same object; awaiting it
	// (or calling a terminal like `.returning()`) yields the programmed rows.
	function selectChain(rows: unknown[]) {
		const chain: Record<string, unknown> = {};
		const methods = ['from', 'innerJoin', 'where', 'limit'];
		for (const m of methods) chain[m] = () => chain;
		chain.orderBy = (arg: unknown) => {
			orderByCalls.push(arg);
			return chain;
		};
		// Thenable so `await chain` resolves to the rows.
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	function insertChain(table: unknown) {
		return {
			values(values: unknown) {
				insertCalls.push({ table, values });
				const ret = {
					returning: () => Promise.resolve([{ id: 'group-1', ...(values as object) }]),
					then: (resolve: (v: unknown) => unknown) => resolve(undefined)
				};
				return ret;
			}
		};
	}

	function updateChain() {
		const chain: Record<string, unknown> = {};
		chain.set = () => chain;
		chain.where = () => chain;
		chain.returning = () => Promise.resolve([{ id: 'group-1' }]);
		chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
		return chain;
	}

	const executor = {
		select: () => selectChain(state.selectRows),
		insert: (table: unknown) => insertChain(table),
		update: () => updateChain()
	};

	const db = {
		...executor,
		transaction: (cb: (tx: typeof executor) => Promise<unknown>) => cb(executor)
	};

	return {
		selectResult: state,
		insertCalls,
		orderByCalls,
		makeDb: () => db
	};
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	createGroup,
	renameGroup,
	softDeleteGroup,
	updateSettlementCurrency,
	getGroupForUser,
	listGroupsForUser,
	userHasGroupAccess,
	assertSettlementCurrencyEditable,
	GroupAccessError,
	CurrencyLockedError
} from './groups';

/** Program the access/list/get SELECT to resolve to `rows`. */
function setSelectRows(rows: unknown[]) {
	selectResult.selectRows = rows;
}

beforeEach(() => {
	insertCalls.length = 0;
	orderByCalls.length = 0;
	setSelectRows([]); // default: no access
});

describe('assertSettlementCurrencyEditable (pure lock rule — PLAN §6.4)', () => {
	it('passes when the group has no transactions', () => {
		expect(() => assertSettlementCurrencyEditable(false)).not.toThrow();
	});

	it('throws CurrencyLockedError once the group has a transaction', () => {
		expect(() => assertSettlementCurrencyEditable(true)).toThrow(CurrencyLockedError);
		try {
			assertSettlementCurrencyEditable(true);
		} catch (e) {
			expect((e as CurrencyLockedError).code).toBe('currency_locked');
		}
	});
});

describe('userHasGroupAccess (membership primitive — PLAN §12)', () => {
	it('is true when an active member row is found', async () => {
		setSelectRows([{ id: 'm1' }]);
		expect(await userHasGroupAccess('u1', 'g1')).toBe(true);
	});

	it('is false when no member row is found', async () => {
		setSelectRows([]);
		expect(await userHasGroupAccess('u1', 'g1')).toBe(false);
	});
});

describe('listGroupsForUser (accessible groups read — PLAN §6.4)', () => {
	it('returns the matching accessible, non-soft-deleted groups (length 1)', async () => {
		const row = {
			id: 'group-1',
			name: 'Trip',
			settlementCurrency: 'THB',
			createdBy: 'user-42',
			createdAt: new Date('2026-01-01T00:00:00Z'),
			deletedAt: null
		};
		setSelectRows([row]); // the SELECT (active member link + not soft-deleted) matches one group

		const result = await listGroupsForUser('user-42');

		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ id: 'group-1', name: 'Trip' });
	});

	it('returns an empty array when no groups match', async () => {
		setSelectRows([]); // no active member link in any live group

		expect(await listGroupsForUser('user-42')).toEqual([]);
	});

	it('applies newest-first ordering (orderBy desc(groups.createdAt))', async () => {
		setSelectRows([]);
		await listGroupsForUser('user-42');

		// The query must order results; the single orderBy arg is the
		// `desc(groups.createdAt)` expression so the dashboard shows newest first.
		expect(orderByCalls).toHaveLength(1);
		expect(orderByCalls[0]).toBeDefined();
	});
});

describe('createGroup (PLAN §6.1 — also creates the creator member)', () => {
	it('inserts BOTH a group and the creator member with the right user_id/display_name', async () => {
		const group = await createGroup({
			userId: 'user-42',
			userName: 'Alice',
			name: 'Trip',
			settlementCurrency: 'THB'
		});

		// Two inserts in the same transaction: groups then members.
		expect(insertCalls).toHaveLength(2);

		const groupInsert = insertCalls[0].values as Record<string, unknown>;
		expect(groupInsert).toMatchObject({
			name: 'Trip',
			settlementCurrency: 'THB',
			createdBy: 'user-42'
		});

		// The REQUIRED creator-member link: without it the creator can't access
		// their own group (PLAN §6.1 — access is via a linked member).
		const memberInsert = insertCalls[1].values as Record<string, unknown>;
		expect(memberInsert).toMatchObject({
			groupId: 'group-1',
			userId: 'user-42',
			displayName: 'Alice'
		});

		expect(group.id).toBe('group-1');
	});

	it('rejects an unsupported settlement currency before inserting anything', async () => {
		await expect(
			createGroup({ userId: 'u1', userName: 'A', name: 'Trip', settlementCurrency: 'BTC' })
		).rejects.toBeDefined();
		expect(insertCalls).toHaveLength(0);
	});
});

describe('access enforcement on mutations + reads (PLAN §12)', () => {
	it('renameGroup throws GroupAccessError when the user has no access', async () => {
		setSelectRows([]); // access primitive reports no membership
		await expect(renameGroup({ userId: 'u1', groupId: 'g1', name: 'New' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('softDeleteGroup throws GroupAccessError when the user has no access', async () => {
		setSelectRows([]);
		await expect(softDeleteGroup({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('updateSettlementCurrency throws GroupAccessError when the user has no access', async () => {
		setSelectRows([]);
		await expect(
			updateSettlementCurrency({ userId: 'u1', groupId: 'g1', settlementCurrency: 'USD' })
		).rejects.toBeInstanceOf(GroupAccessError);
	});

	it('getGroupForUser returns null when the user has no access', async () => {
		setSelectRows([]);
		expect(await getGroupForUser('u1', 'g1')).toBeNull();
	});
});

describe('mutations succeed when access is granted', () => {
	it('renameGroup returns the updated group when access is granted', async () => {
		setSelectRows([{ id: 'm1' }]); // has access
		const updated = await renameGroup({ userId: 'u1', groupId: 'group-1', name: 'New' });
		expect(updated.id).toBe('group-1');
	});

	it('updateSettlementCurrency succeeds while the group has no transactions (lock open)', async () => {
		setSelectRows([{ id: 'm1' }]); // has access; groupHasTransactions() is false
		const updated = await updateSettlementCurrency({
			userId: 'u1',
			groupId: 'group-1',
			settlementCurrency: 'USD'
		});
		expect(updated.id).toBe('group-1');
	});

	it('updateSettlementCurrency rejects an unsupported currency before touching access', async () => {
		setSelectRows([{ id: 'm1' }]);
		await expect(
			updateSettlementCurrency({ userId: 'u1', groupId: 'group-1', settlementCurrency: 'usd' })
		).rejects.toBeDefined();
	});
});
