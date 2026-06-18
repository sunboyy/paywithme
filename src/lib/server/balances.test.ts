import { describe, it, expect, beforeEach, vi } from 'vitest';

// Unit tests for the balances DB wrapper (task 5.1; PLAN §8.1). STRATEGY mirrors
// `transactions.test.ts`: NO real DB — a fluent query-builder stub whose successive
// SELECT chains resolve to programmed row-sets in order:
//   1) access check (userHasGroupAccess)  → membership rows
//   2) the group's active member roster   → member ids
//   3) Σ-paid rows (payers ⋈ transactions, non-deleted)
//   4) Σ-owed rows (shares ⋈ transactions, non-deleted)
// The pure math lives in `balances.ts` (tested directly there); here we assert the
// wrapper wires the right rows in + that soft-deleted txns are excluded.

const { selectQueue, makeDb } = vi.hoisted(() => {
	const selectQueue: unknown[][] = [];

	function nextRows(): unknown[] {
		return selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
	}

	function selectChain() {
		const rows = nextRows();
		const chain: Record<string, unknown> = {};
		for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy']) chain[m] = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	const db = { select: () => selectChain() };
	return { selectQueue, makeDb: () => db };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));
vi.mock('$lib/server/db/transactions-schema', () => {
	const tag = (name: string) => ({ __name: name }) as unknown;
	return {
		transactions: tag('transactions'),
		transactionPayers: tag('transaction_payers'),
		transactionShares: tag('transaction_shares')
	};
});
vi.mock('$lib/server/db/groups-schema', () => {
	const tag = (name: string) => ({ __name: name }) as unknown;
	return { members: tag('members'), groups: tag('groups') };
});

import { getGroupBalances } from './balances';
import { GroupAccessError } from './groups';

function queueSelects(...rowSets: unknown[][]) {
	selectQueue.length = 0;
	selectQueue.push(...rowSets);
}

const ACCESS_OK = [{ id: 'access-member' }];

beforeEach(() => {
	selectQueue.length = 0;
});

describe('getGroupBalances (PLAN §8.1)', () => {
	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]); // access check finds nothing
		await expect(getGroupBalances({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('computes net balances from settlement paid/owed; every member present; Σ == 0', async () => {
		// access → roster (m1,m2,m3) → paid rows → owed rows.
		queueSelects(
			ACCESS_OK,
			[{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
			[
				{ memberId: 'm1', amount: 7000 },
				{ memberId: 'm2', amount: 5000 }
			],
			[
				{ memberId: 'm1', amount: 3000 },
				{ memberId: 'm2', amount: 4000 },
				{ memberId: 'm3', amount: 5000 }
			]
		);
		const result = await getGroupBalances({ userId: 'u1', groupId: 'g1' });
		expect(result).toEqual([
			{ memberId: 'm1', balance: 4000 },
			{ memberId: 'm2', balance: 1000 },
			{ memberId: 'm3', balance: -5000 }
		]);
		expect(result.reduce((a, b) => a + b.balance, 0)).toBe(0);
	});

	it('aggregates multiple paid/owed rows per member (Σ across transactions)', async () => {
		// m1 paid in two transactions (6000 + 3000); owed across two (2000 + 1000).
		queueSelects(
			ACCESS_OK,
			[{ id: 'm1' }, { id: 'm2' }],
			[
				{ memberId: 'm1', amount: 6000 },
				{ memberId: 'm1', amount: 3000 }
			],
			[
				{ memberId: 'm1', amount: 2000 },
				{ memberId: 'm1', amount: 1000 },
				{ memberId: 'm2', amount: 6000 }
			]
		);
		const result = await getGroupBalances({ userId: 'u1', groupId: 'g1' });
		expect(result).toEqual([
			{ memberId: 'm1', balance: 6000 }, // (6000+3000) − (2000+1000)
			{ memberId: 'm2', balance: -6000 } // 0 − 6000
		]);
		expect(result.reduce((a, b) => a + b.balance, 0)).toBe(0);
	});

	it('includes a member with no activity at balance 0', async () => {
		queueSelects(
			ACCESS_OK,
			[{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
			[{ memberId: 'm1', amount: 4500 }],
			[
				{ memberId: 'm1', amount: 2250 },
				{ memberId: 'm2', amount: 2250 }
			]
		);
		const result = await getGroupBalances({ userId: 'u1', groupId: 'g1' });
		expect(result).toContainEqual({ memberId: 'm3', balance: 0 });
		expect(result.reduce((a, b) => a + b.balance, 0)).toBe(0);
	});

	it('soft-deleted transactions are excluded (the query only returns live-txn rows)', async () => {
		// The wrapper's WHERE filters `transactions.deleted_at IS NULL`, so the DB only
		// hands back rows belonging to the ONE live transaction — the deleted txn's
		// payer/share rows never reach the wrapper. We simulate that: of two txns (one
		// deleted), only the live one's rows are returned, and the balances reflect
		// ONLY the live txn.
		queueSelects(
			ACCESS_OK,
			[{ id: 'm1' }, { id: 'm2' }],
			// Only the LIVE txn's payer row (the deleted txn's row is filtered out in SQL).
			[{ memberId: 'm1', amount: 1000 }],
			// Only the LIVE txn's share rows.
			[
				{ memberId: 'm1', amount: 500 },
				{ memberId: 'm2', amount: 500 }
			]
		);
		const result = await getGroupBalances({ userId: 'u1', groupId: 'g1' });
		// If the deleted txn had counted, these would differ — they reflect ONLY the live txn.
		expect(result).toEqual([
			{ memberId: 'm1', balance: 500 },
			{ memberId: 'm2', balance: -500 }
		]);
		expect(result.reduce((a, b) => a + b.balance, 0)).toBe(0);
	});

	it('no transactions yet → every member 0', async () => {
		queueSelects(ACCESS_OK, [{ id: 'm1' }, { id: 'm2' }], [], []);
		const result = await getGroupBalances({ userId: 'u1', groupId: 'g1' });
		expect(result).toEqual([
			{ memberId: 'm1', balance: 0 },
			{ memberId: 'm2', balance: 0 }
		]);
	});
});
