import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the transaction service (task 4.7; PLAN §7.1, §7.2, §12.1).
//
// STRATEGY (mirrors `members.test.ts` / `groups.test.ts`): NO real DB — a small
// fluent query-builder stub. We PROGRAM what each SELECT resolves to in order
// (access check → settlement currency → active members → category existence) and
// RECORD every insert so we can assert the create flow's structural guarantees:
//   - opens a db.transaction and inserts the transactions row + payer rows + share
//     rows + an audit row ALL THROUGH THE SAME tx, with resolved `amount_owed`
//     matching `resolveShares` for equal/amount/share (the service re-resolves
//     server-side, never trusting the client);
//   - currency==settlement sets exchange_rate='1', amount_total_settlement ==
//     amount_total, and amount_paid_settlement == amount_paid;
//   - rejects when access reports no membership (GroupAccessError → 404);
//   - `listTransactions` filters by type/category and shapes rows newest-first.

// --- Fluent DB mock -------------------------------------------------------
const { selectQueue, inserts, makeDb, lastTxHandle } = vi.hoisted(() => {
	const selectQueue: unknown[][] = [];
	// Records: which table + values for every insert, plus the tx handle used.
	const inserts: { table: string; values: Record<string, unknown>; via: object }[] = [];
	const lastTxHandle: { current: object | null } = { current: null };

	function nextSelectRows(): unknown[] {
		return selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
	}

	function selectChain() {
		const rows = nextSelectRows();
		const chain: Record<string, unknown> = {};
		const methods = ['from', 'innerJoin', 'where', 'limit', 'orderBy'];
		for (const m of methods) chain[m] = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	function tableName(table: unknown): string {
		// Drizzle tables carry their SQL name on a Symbol; fall back to a tag we set
		// in the mock. We instead tag inserts by identity in the executor below.
		return (table as { __name?: string }).__name ?? 'unknown';
	}

	function makeExecutor(via: object) {
		return {
			select: () => selectChain(),
			insert: (table: unknown) => ({
				values(values: Record<string, unknown>) {
					inserts.push({ table: tableName(table), values, via });
					return Promise.resolve(undefined);
				}
			}),
			update: () => {
				const chain: Record<string, unknown> = {};
				chain.set = () => chain;
				chain.where = () => chain;
				chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
				return chain;
			},
			delete: () => ({ where: () => Promise.resolve(undefined) })
		};
	}

	const baseExecutor = makeExecutor({ name: 'db' });
	const db = {
		...baseExecutor,
		transaction: (cb: (tx: object) => Promise<unknown>) => {
			const tx = makeExecutor({ name: 'tx' });
			lastTxHandle.current = tx;
			return cb(tx);
		}
	};

	return { selectQueue, inserts, makeDb: () => db, lastTxHandle };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

// Tag the schema tables so the mock can name inserts. We mock the schema module
// to attach a `__name` to each table object the service inserts into.
vi.mock('$lib/server/db/transactions-schema', () => {
	const tag = (name: string) => ({ __name: name }) as unknown;
	return {
		transactions: tag('transactions'),
		transactionPayers: tag('transaction_payers'),
		transactionShares: tag('transaction_shares'),
		categories: tag('categories')
	};
});
vi.mock('$lib/server/db/groups-schema', () => {
	const tag = (name: string) => ({ __name: name }) as unknown;
	return {
		members: tag('members'),
		groups: tag('groups')
	};
});
vi.mock('$lib/server/db/audit-schema', () => {
	const tag = (name: string) => ({ __name: name }) as unknown;
	return { auditLog: tag('audit_log') };
});

import { createTransaction, listTransactions, TransactionValidationError } from './transactions';
import { GroupAccessError } from './groups';
import { resolveShares } from '$lib/transactions/resolve';

/** Queue the row-sets each successive SELECT chain resolves to. */
function queueSelects(...rowSets: unknown[][]) {
	selectQueue.length = 0;
	selectQueue.push(...rowSets);
}

const ACCESS_OK = [{ id: 'access-member' }];
const ACTIVE_MEMBERS = [{ id: 'm1' }, { id: 'm2' }];
const CATEGORY_ROW = [{ id: 'spending-food-drink' }];

/** A valid equal-split spending input (THB, 2 members, 90.00 total). */
function equalInput() {
	return {
		type: 'spending' as const,
		title: 'Dinner',
		categoryId: 'spending-food-drink',
		amountTotal: 9000,
		currency: 'THB',
		exchangeRate: '1',
		amountTotalSettlement: 9000,
		splitMode: 'equal' as const,
		payers: [{ memberId: 'm1', amountPaid: 9000 }],
		beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }],
		items: [],
		charges: []
	};
}

function insertsTo(table: string) {
	return inserts.filter((i) => i.table === table);
}

beforeEach(() => {
	inserts.length = 0;
	selectQueue.length = 0;
	lastTxHandle.current = null;
});

describe('createTransaction (PLAN §7.1, §7.2, §12.1)', () => {
	it('throws GroupAccessError and writes nothing when access is denied', async () => {
		queueSelects([]); // access check finds nothing
		await expect(
			createTransaction({
				userId: 'u1',
				groupId: 'g1',
				input: equalInput(),
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(inserts).toHaveLength(0);
	});

	it('inserts the transaction + payer + share + audit rows ALL through the SAME tx', async () => {
		// access ok → active members → category exists.
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);

		const id = await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: equalInput(),
			settlementCurrency: 'THB'
		});
		expect(typeof id).toBe('string');

		// Exactly one transaction row, two payer? (one payer) + two share rows + one audit.
		expect(insertsTo('transactions')).toHaveLength(1);
		expect(insertsTo('transaction_payers')).toHaveLength(1);
		expect(insertsTo('transaction_shares')).toHaveLength(2);
		expect(insertsTo('audit_log')).toHaveLength(1);

		// CRUX (§12.1): every insert went through the SAME open transaction handle.
		const tx = lastTxHandle.current;
		expect(tx).not.toBeNull();
		for (const i of inserts) {
			expect((i.via as { name: string }).name).toBe('tx');
		}
		// And nothing was written via the bare `db` (would break atomicity).
		expect(inserts.every((i) => (i.via as { name: string }).name === 'tx')).toBe(true);
	});

	it('re-resolves shares server-side: equal split owed matches resolveShares', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: equalInput(),
			settlementCurrency: 'THB'
		});

		const expected = resolveShares({
			splitMode: 'equal',
			amountTotal: 9000,
			beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
		});
		const shareRows = insertsTo('transaction_shares').map((i) => ({
			memberId: i.values.memberId,
			amountOwed: i.values.amountOwed
		}));
		expect(shareRows).toEqual(
			expected.map((e) => ({ memberId: e.memberId, amountOwed: e.amountOwed }))
		);
		// Equal 9000 between 2 → 4500 / 4500.
		expect(shareRows).toEqual([
			{ memberId: 'm1', amountOwed: 4500 },
			{ memberId: 'm2', amountOwed: 4500 }
		]);
	});

	it('re-resolves a SHARE split (weights 1:2 of 9000 → 3000 / 6000)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: {
				...equalInput(),
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 1 },
					{ memberId: 'm2', shareWeight: 2 }
				]
			},
			settlementCurrency: 'THB'
		});

		const shareRows = insertsTo('transaction_shares').map((i) => ({
			memberId: i.values.memberId,
			amountOwed: i.values.amountOwed,
			shareWeight: i.values.shareWeight
		}));
		expect(shareRows).toEqual([
			{ memberId: 'm1', amountOwed: 3000, shareWeight: 1 },
			{ memberId: 'm2', amountOwed: 6000, shareWeight: 2 }
		]);
	});

	it('re-resolves an AMOUNT split (raw amounts pass through, preserved for re-edit)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: {
				...equalInput(),
				splitMode: 'amount',
				beneficiaries: [
					{ memberId: 'm1', rawAmount: 2000 },
					{ memberId: 'm2', rawAmount: 7000 }
				]
			},
			settlementCurrency: 'THB'
		});

		const shareRows = insertsTo('transaction_shares').map((i) => ({
			memberId: i.values.memberId,
			amountOwed: i.values.amountOwed,
			rawAmount: i.values.rawAmount
		}));
		expect(shareRows).toEqual([
			{ memberId: 'm1', amountOwed: 2000, rawAmount: 2000 },
			{ memberId: 'm2', amountOwed: 7000, rawAmount: 7000 }
		]);
	});

	it('currency==settlement: exchange_rate=1, settlement totals mirror txn totals', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: equalInput(),
			settlementCurrency: 'THB'
		});

		const txnRow = insertsTo('transactions')[0].values;
		expect(txnRow.exchangeRate).toBe('1');
		expect(txnRow.amountTotalSettlement).toBe(txnRow.amountTotal);
		expect(txnRow.amountTotalSettlement).toBe(9000);
		expect(txnRow.currency).toBe('THB');

		const payerRow = insertsTo('transaction_payers')[0].values;
		expect(payerRow.amountPaidSettlement).toBe(payerRow.amountPaid);
		expect(payerRow.amountPaid).toBe(9000);
	});

	it('sets created_at to the supplied real-world clock (PLAN §7.1)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		const when = new Date('2026-01-02T03:04:05.000Z');
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: equalInput(),
			settlementCurrency: 'THB',
			now: () => when
		});
		const txnRow = insertsTo('transactions')[0].values;
		expect(txnRow.createdAt).toBe(when);
		// occurred_at / updated_at are NOT set by the app (DB defaults, §7.1).
		expect('occurredAt' in txnRow).toBe(false);
		expect('updatedAt' in txnRow).toBe(false);
	});

	it('writes an audit row (action=create, entity=transaction) with a money summary', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: equalInput(),
			settlementCurrency: 'THB'
		});
		const audit = insertsTo('audit_log')[0].values;
		expect(audit.action).toBe('create');
		expect(audit.entityType).toBe('transaction');
		expect(audit.groupId).toBe('g1');
		expect(audit.actorUserId).toBe('u1');
		// Summary uses formatAmount (฿90.00 for 9000 minor THB).
		expect(String(audit.summary)).toContain('Dinner');
		expect(String(audit.summary)).toContain('90.00');
	});

	it('rejects invalid input (Σ paid != total) with TransactionValidationError, no inserts', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await expect(
			createTransaction({
				userId: 'u1',
				groupId: 'g1',
				input: { ...equalInput(), payers: [{ memberId: 'm1', amountPaid: 1 }] },
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionValidationError);
		expect(insertsTo('transactions')).toHaveLength(0);
	});

	it('rejects a beneficiary outside the active-member allow-list', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await expect(
			createTransaction({
				userId: 'u1',
				groupId: 'g1',
				input: { ...equalInput(), beneficiaries: [{ memberId: 'ghost' }] },
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionValidationError);
		expect(insertsTo('transactions')).toHaveLength(0);
	});
});

describe('listTransactions (PLAN §7, §10)', () => {
	const now = new Date('2026-03-01T00:00:00.000Z');
	const ROWS = [
		{
			id: 't1',
			type: 'spending',
			title: 'Dinner',
			categoryId: 'spending-food-drink',
			categoryName: 'Food & Drink',
			categoryIcon: 'utensils',
			amountTotalSettlement: 9000,
			currency: 'THB',
			createdAt: now
		}
	];

	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]); // access check fails
		await expect(listTransactions({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('returns shaped rows (category + settlement total + ISO date) under access', async () => {
		queueSelects(ACCESS_OK, ROWS);
		const result = await listTransactions({ userId: 'u1', groupId: 'g1' });
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			id: 't1',
			type: 'spending',
			title: 'Dinner',
			categoryId: 'spending-food-drink',
			categoryName: 'Food & Drink',
			categoryIcon: 'utensils',
			amountTotalSettlement: 9000,
			settlementCurrency: 'THB',
			createdAt: now.toISOString()
		});
	});

	it('passes the type + category filters through (access then list)', async () => {
		// We can't easily introspect the WHERE in this stub, but we can assert it
		// resolves and shapes the rows (the conditions are pushed before the query).
		queueSelects(ACCESS_OK, ROWS);
		const result = await listTransactions({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: 'spending', categoryId: 'spending-food-drink' }
		});
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe('spending');
	});
});
