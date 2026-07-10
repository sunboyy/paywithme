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
const { selectQueue, inserts, updates, deletes, makeDb, lastTxHandle } = vi.hoisted(() => {
	const selectQueue: unknown[][] = [];
	// Records: which table + values for every insert, plus the tx handle used.
	const inserts: { table: string; values: Record<string, unknown>; via: object }[] = [];
	// Records: which table + the .set() values for every update, plus the tx handle.
	const updates: { table: string; values: Record<string, unknown>; via: object }[] = [];
	// Records: which table was deleted from, plus the tx handle.
	const deletes: { table: string; via: object }[] = [];
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
			update: (table: unknown) => {
				const chain: Record<string, unknown> = {};
				chain.set = (values: Record<string, unknown>) => {
					updates.push({ table: tableName(table), values, via });
					return chain;
				};
				chain.where = () => chain;
				chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
				return chain;
			},
			delete: (table: unknown) => ({
				where: () => {
					deletes.push({ table: tableName(table), via });
					return Promise.resolve(undefined);
				}
			})
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

	return { selectQueue, inserts, updates, deletes, makeDb: () => db, lastTxHandle };
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
		transactionItems: tag('transaction_items'),
		transactionItemShares: tag('transaction_item_shares'),
		transactionCharges: tag('transaction_charges'),
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

import {
	createTransaction,
	listTransactions,
	getTransactionDetail,
	updateTransaction,
	softDeleteTransaction,
	restoreTransaction,
	TransactionValidationError,
	TransactionNotFoundError,
	TransactionDeletedError,
	TransactionCursorError,
	encodeTransactionCursor,
	decodeTransactionCursor,
	rowIsAfterCursor,
	createdAtInRange,
	type TransactionCursorKey
} from './transactions';
import { GroupAccessError } from './groups';
import { resolveShares, resolveItemizedWithCharges } from '$lib/transactions/resolve';
import {
	applyCharges,
	convertToSettlement,
	buildTransactionSchema,
	type ChargeInput
} from '$lib/schemas/transaction';

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
	updates.length = 0;
	deletes.length = 0;
	selectQueue.length = 0;
	lastTxHandle.current = null;
});

function updatesTo(table: string) {
	return updates.filter((u) => u.table === table);
}
function deletesTo(table: string) {
	return deletes.filter((d) => d.table === table);
}

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

	it('FOREIGN currency: persists real currency + rate + server-recomputed settlement total (§7.6)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		// CN¥90.00 equal split between m1/m2 in a THB group @4.85.
		const settlementTotal = convertToSettlement(9000, 'CNY', 'THB', '4.85');
		expect(settlementTotal).toBe(43650); // ฿436.50
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: {
				...equalInput(),
				currency: 'CNY',
				exchangeRate: '4.85',
				amountTotalSettlement: settlementTotal
			},
			settlementCurrency: 'THB'
		});

		const txnRow = insertsTo('transactions')[0].values;
		expect(txnRow.currency).toBe('CNY');
		expect(txnRow.exchangeRate).toBe('4.85');
		expect(txnRow.amountTotal).toBe(9000); // CNY entry minor
		expect(txnRow.amountTotalSettlement).toBe(settlementTotal);

		// transaction_shares in SETTLEMENT minor units summing to the settlement total.
		const shareRows = insertsTo('transaction_shares');
		const shareSum = shareRows.reduce((acc, i) => acc + (i.values.amountOwed as number), 0);
		expect(shareSum).toBe(settlementTotal);
		// Equal split of ฿436.50 → 21825 each.
		expect(shareRows.map((i) => i.values.amountOwed)).toEqual([21825, 21825]);

		// Payer paid stays CNY; paid_settlement sums to the settlement total.
		const payer = insertsTo('transaction_payers')[0].values;
		expect(payer.amountPaid).toBe(9000); // CNY
		expect(payer.amountPaidSettlement).toBe(settlementTotal); // single payer gets it all
	});

	it('rejects a wrong client amountTotalSettlement (schema is the gate, server never trusts it)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		// CNY @4.85 → correct settlement is 43650; pass a deliberately WRONG client value.
		await expect(
			createTransaction({
				userId: 'u1',
				groupId: 'g1',
				input: {
					...equalInput(),
					currency: 'CNY',
					exchangeRate: '4.85',
					amountTotalSettlement: 1 // wrong (correct = 43650)
				},
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionValidationError);
		expect(insertsTo('transactions')).toHaveLength(0);
	});

	it('sets created_at from the editable date field, anchored at noon UTC (PLAN §7.1)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			// The user backdated the entry to 2026-01-02 (the real-world date).
			input: { ...equalInput(), date: '2026-01-02' },
			settlementCurrency: 'THB'
		});
		const txnRow = insertsTo('transactions')[0].values;
		// Stored at noon UTC of the picked day so the rendered local date matches it.
		expect((txnRow.createdAt as Date).toISOString()).toBe('2026-01-02T12:00:00.000Z');
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

describe('createTransaction — itemized split (PLAN §7.2.1, task 4.8)', () => {
	// A valid itemized spending: two items (Pizza 100 across m1/m2/m3 equal; Wine 10
	// across m1:1/m2:2 share). items_subtotal = amount_total = 110, no charges.
	function itemizedInput() {
		const items = [
			{
				label: 'Pizza',
				amount: 100,
				splitMode: 'equal' as const,
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
			},
			{
				label: 'Wine',
				amount: 10,
				splitMode: 'share' as const,
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 1 },
					{ memberId: 'm2', shareWeight: 2 }
				]
			}
		];
		return {
			type: 'spending' as const,
			title: 'Group dinner',
			categoryId: 'spending-food-drink',
			amountTotal: 110,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 110,
			splitMode: 'itemized' as const,
			payers: [{ memberId: 'm1', amountPaid: 110 }],
			beneficiaries: [],
			items,
			charges: []
		};
	}

	it('inserts items + item-shares + aggregated shares + audit ALL through the SAME tx', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: itemizedInput(),
			settlementCurrency: 'THB'
		});

		expect(insertsTo('transactions')).toHaveLength(1);
		expect(insertsTo('transaction_items')).toHaveLength(2); // 2 items
		// item-shares: Pizza 2 + Wine 2 = 4.
		expect(insertsTo('transaction_item_shares')).toHaveLength(4);
		// aggregated shares: m1 + m2 = 2.
		expect(insertsTo('transaction_shares')).toHaveLength(2);
		expect(insertsTo('audit_log')).toHaveLength(1);

		// Every insert went through the SAME open transaction handle (§12.1 atomicity).
		expect(inserts.every((i) => (i.via as { name: string }).name === 'tx')).toBe(true);
	});

	it('persists item rows with label, amount and sort_order; item-shares carry per-item mode + inputs', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: itemizedInput(),
			settlementCurrency: 'THB'
		});

		const itemRows = insertsTo('transaction_items').map((i) => ({
			label: i.values.label,
			amount: i.values.amount,
			sortOrder: i.values.sortOrder
		}));
		expect(itemRows).toEqual([
			{ label: 'Pizza', amount: 100, sortOrder: 0 },
			{ label: 'Wine', amount: 10, sortOrder: 1 }
		]);

		// Each item row got a generated id; item-shares reference one of those ids.
		const itemIds = insertsTo('transaction_items').map((i) => i.values.id);
		const itemShareRows = insertsTo('transaction_item_shares').map((i) => ({
			itemId: i.values.itemId,
			memberId: i.values.memberId,
			amountOwed: i.values.amountOwed,
			splitMode: i.values.splitMode,
			shareWeight: i.values.shareWeight,
			rawAmount: i.values.rawAmount
		}));
		expect(itemShareRows.every((r) => itemIds.includes(r.itemId))).toBe(true);
		// Pizza (equal 100/2 → 50/50), Wine (share 1:2 of 10 → 3/7).
		expect(itemShareRows).toEqual([
			{
				itemId: itemIds[0],
				memberId: 'm1',
				amountOwed: 50,
				splitMode: 'equal',
				shareWeight: null,
				rawAmount: null
			},
			{
				itemId: itemIds[0],
				memberId: 'm2',
				amountOwed: 50,
				splitMode: 'equal',
				shareWeight: null,
				rawAmount: null
			},
			{
				itemId: itemIds[1],
				memberId: 'm1',
				amountOwed: 3,
				splitMode: 'share',
				shareWeight: 1,
				rawAmount: null
			},
			{
				itemId: itemIds[1],
				memberId: 'm2',
				amountOwed: 7,
				splitMode: 'share',
				shareWeight: 2,
				rawAmount: null
			}
		]);
	});

	it('aggregated transaction_shares equal the resolver output and sum to amount_total', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: itemizedInput(),
			settlementCurrency: 'THB'
		});

		const expected = resolveItemizedWithCharges(itemizedInput().items, []).shares;
		const shareRows = insertsTo('transaction_shares').map((i) => ({
			memberId: i.values.memberId,
			amountOwed: i.values.amountOwed,
			shareWeight: i.values.shareWeight,
			rawAmount: i.values.rawAmount
		}));
		expect(shareRows.map((r) => ({ memberId: r.memberId, amountOwed: r.amountOwed }))).toEqual(
			expected.map((e) => ({ memberId: e.memberId, amountOwed: e.amountOwed }))
		);
		// m1: 50 + 3 = 53; m2: 50 + 7 = 57. Aggregated, NO per-item inputs at top level.
		expect(shareRows).toEqual([
			{ memberId: 'm1', amountOwed: 53, shareWeight: null, rawAmount: null },
			{ memberId: 'm2', amountOwed: 57, shareWeight: null, rawAmount: null }
		]);
		const sum = shareRows.reduce((acc, r) => acc + (r.amountOwed as number), 0);
		expect(sum).toBe(110); // == amount_total (= items_subtotal, no charges)
	});

	it('rejects an itemized TRANSFER (transfers are never itemized, §7.2.3)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await expect(
			createTransaction({
				userId: 'u1',
				groupId: 'g1',
				input: {
					...itemizedInput(),
					type: 'transfer' as const,
					categoryId: 'transfer-debt-settlement'
				},
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionValidationError);
		expect(insertsTo('transactions')).toHaveLength(0);
	});
});

describe('createTransaction — itemized + charges/discounts (PLAN §7.2.2-3, task 4.9)', () => {
	// subtotal 110 (Pizza 100 m1/m2 equal; Wine 10 m1:1/m2:2 share), then a 10%
	// service (items_subtotal) + a flat 5 discount (running_total).
	//   service +11 → running 121; discount −5 → 116. amount_total = 116.
	function chargedInput() {
		const items = [
			{
				label: 'Pizza',
				amount: 100,
				splitMode: 'equal' as const,
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
			},
			{
				label: 'Wine',
				amount: 10,
				splitMode: 'share' as const,
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 1 },
					{ memberId: 'm2', shareWeight: 2 }
				]
			}
		];
		const charges: ChargeInput[] = [
			{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'discount', mode: 'absolute', value: 5, base: 'running_total', sortOrder: 1 }
		];
		const amountTotal = applyCharges(110, charges).amountTotal; // 116
		return {
			type: 'spending' as const,
			title: 'Group dinner',
			categoryId: 'spending-food-drink',
			amountTotal,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: amountTotal,
			splitMode: 'itemized' as const,
			payers: [{ memberId: 'm1', amountPaid: amountTotal }],
			beneficiaries: [],
			items,
			charges
		};
	}

	it('inserts transaction_charges rows (kind/mode/value/base/sort_order) through the SAME tx', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: chargedInput(),
			settlementCurrency: 'THB'
		});

		const chargeRows = insertsTo('transaction_charges').map((i) => ({
			transactionId: i.values.transactionId,
			kind: i.values.kind,
			mode: i.values.mode,
			value: i.values.value,
			base: i.values.base,
			sortOrder: i.values.sortOrder
		}));
		expect(chargeRows).toHaveLength(2);
		expect(chargeRows.map((r) => ({ ...r, transactionId: undefined }))).toEqual([
			{
				transactionId: undefined,
				kind: 'service',
				mode: 'percent',
				value: 1000,
				base: 'items_subtotal',
				sortOrder: 0
			},
			{
				transactionId: undefined,
				kind: 'discount',
				mode: 'absolute',
				value: 5,
				base: 'running_total',
				sortOrder: 1
			}
		]);
		// All inserts (incl. charges) went through the same open tx handle (§12.1).
		expect(inserts.every((i) => (i.via as { name: string }).name === 'tx')).toBe(true);
	});

	it('aggregated transaction_shares reflect allocated charges and Σ == amount_total', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: chargedInput(),
			settlementCurrency: 'THB'
		});

		// The service re-resolves with charges; assert the share rows match the resolver.
		const expected = resolveItemizedWithCharges(chargedInput().items, chargedInput().charges);
		const shareRows = insertsTo('transaction_shares').map((i) => ({
			memberId: i.values.memberId,
			amountOwed: i.values.amountOwed
		}));
		expect(shareRows).toEqual(
			expected.shares.map((e) => ({ memberId: e.memberId, amountOwed: e.amountOwed }))
		);
		const sum = shareRows.reduce((acc, r) => acc + (r.amountOwed as number), 0);
		expect(sum).toBe(116); // == amount_total (subtotal 110 + service 11 − discount 5)
		expect(sum).toBe(expected.amountTotal);
		// The transaction row's total matches.
		expect(insertsTo('transactions')[0].values.amountTotal).toBe(116);
		expect(insertsTo('transactions')[0].values.amountTotalSettlement).toBe(116);
	});

	it('persists item-shares AND charges AND aggregated shares in one create', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: chargedInput(),
			settlementCurrency: 'THB'
		});
		expect(insertsTo('transaction_items')).toHaveLength(2);
		expect(insertsTo('transaction_item_shares')).toHaveLength(4); // 2 + 2
		expect(insertsTo('transaction_charges')).toHaveLength(2);
		expect(insertsTo('transaction_shares')).toHaveLength(2);
		expect(insertsTo('audit_log')).toHaveLength(1);
	});

	it('FOREIGN currency itemized + charges end-to-end: settlement shares sum to settlement total (§7.6)', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW);
		// The SAME itemized+charges bill, but recorded in CNY @4.85 in a THB group.
		// amount_total (CNY minor) = 116; settlement total = 116 × 4.85 = 562.6 → 563.
		const input = chargedInput();
		const settlementTotal = convertToSettlement(116, 'CNY', 'THB', '4.85');
		expect(settlementTotal).toBe(563);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: {
				...input,
				currency: 'CNY',
				exchangeRate: '4.85',
				amountTotalSettlement: settlementTotal
			},
			settlementCurrency: 'THB'
		});

		// The transaction row persists the REAL currency + rate + recomputed settlement.
		const txnRow = insertsTo('transactions')[0].values;
		expect(txnRow.currency).toBe('CNY');
		expect(txnRow.exchangeRate).toBe('4.85');
		expect(txnRow.amountTotal).toBe(116); // CNY minor (entry currency)
		expect(txnRow.amountTotalSettlement).toBe(settlementTotal);

		// transaction_shares are in SETTLEMENT minor units and sum EXACTLY to the
		// settlement total (convert-then-distribute, §7.6).
		const shareSum = insertsTo('transaction_shares').reduce(
			(acc, i) => acc + (i.values.amountOwed as number),
			0
		);
		expect(shareSum).toBe(settlementTotal);

		// transaction_payers: amount_paid stays CNY; amount_paid_settlement sums to the
		// settlement total too (single payer paid the whole bill → gets it all).
		const payerRows = insertsTo('transaction_payers');
		expect(payerRows[0].values.amountPaid).toBe(116); // CNY entry
		const paidSettlementSum = payerRows.reduce(
			(acc, i) => acc + (i.values.amountPaidSettlement as number),
			0
		);
		expect(paidSettlementSum).toBe(settlementTotal);

		// Everything in ONE tx (§12.1).
		expect(inserts.every((i) => (i.via as { name: string }).name === 'tx')).toBe(true);
	});
});

describe('listTransactions (PLAN §7, §10)', () => {
	const now = new Date('2026-03-01T00:00:00.000Z');
	// Two rows: a same-currency THB row and a FOREIGN CNY row (§7.6 display). Each
	// carries the original entry `amountTotal` + `currency` AND the settlement total.
	const SETTLEMENT_ROW = [{ settlementCurrency: 'THB' }];
	const ROWS = [
		{
			id: 't1',
			type: 'spending',
			title: 'Dinner',
			categoryId: 'spending-food-drink',
			categoryName: 'Food & Drink',
			categoryIcon: 'utensils',
			amountTotal: 9000,
			amountTotalSettlement: 9000,
			currency: 'THB',
			createdAt: now,
			occurredAt: now
		},
		{
			id: 't2',
			type: 'spending',
			title: 'Bubble tea',
			categoryId: 'spending-food-drink',
			categoryName: 'Food & Drink',
			categoryIcon: 'utensils',
			amountTotal: 5000, // CN¥50.00 (entry currency)
			amountTotalSettlement: 24250, // ฿242.50 @4.85
			currency: 'CNY',
			createdAt: now,
			occurredAt: now
		}
	];

	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]); // access check fails
		await expect(listTransactions({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('returns shaped rows with original amount/currency + settlement total denominated in the GROUP currency (§7.6)', async () => {
		// SELECT order: access check → group settlement currency → rows.
		queueSelects(ACCESS_OK, SETTLEMENT_ROW, ROWS);
		const result = await listTransactions({ userId: 'u1', groupId: 'g1' });
		expect(result).toHaveLength(2);
		// Same-currency row: not foreign; original == settlement.
		expect(result[0]).toEqual({
			id: 't1',
			type: 'spending',
			title: 'Dinner',
			categoryId: 'spending-food-drink',
			categoryName: 'Food & Drink',
			categoryIcon: 'utensils',
			amountTotal: 9000,
			currency: 'THB',
			amountTotalSettlement: 9000,
			settlementCurrency: 'THB',
			isForeign: false,
			createdAt: now.toISOString(),
			occurredAt: now.toISOString()
		});
		// Foreign row: original CNY amount kept; settlement total denominated in THB.
		expect(result[1]).toEqual({
			id: 't2',
			type: 'spending',
			title: 'Bubble tea',
			categoryId: 'spending-food-drink',
			categoryName: 'Food & Drink',
			categoryIcon: 'utensils',
			amountTotal: 5000,
			currency: 'CNY',
			amountTotalSettlement: 24250,
			settlementCurrency: 'THB',
			isForeign: true,
			createdAt: now.toISOString(),
			occurredAt: now.toISOString()
		});
	});

	it('passes the type + category filters through (access then list)', async () => {
		// We can't easily introspect the WHERE in this stub, but we can assert it
		// resolves and shapes the rows (the conditions are pushed before the query).
		queueSelects(ACCESS_OK, SETTLEMENT_ROW, ROWS);
		const result = await listTransactions({
			userId: 'u1',
			groupId: 'g1',
			filters: { type: 'spending', categoryId: 'spending-food-drink' }
		});
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe('spending');
	});

	it('surfaces occurredAt (ISO) so the API layer can mint the next-page cursor (§16.4)', async () => {
		const occurred = new Date('2026-03-01T00:00:05.000Z');
		const rows = [{ ...ROWS[0], occurredAt: occurred }];
		queueSelects(ACCESS_OK, SETTLEMENT_ROW, rows);
		const result = await listTransactions({ userId: 'u1', groupId: 'g1' });
		expect(result[0].occurredAt).toBe(occurred.toISOString());
		// The full §16.4 sort key round-trips through the opaque cursor.
		const cursor = encodeTransactionCursor({
			createdAt: new Date(result[0].createdAt),
			occurredAt: new Date(result[0].occurredAt),
			id: result[0].id
		});
		expect(decodeTransactionCursor(cursor)).toEqual({
			createdAt: new Date(result[0].createdAt),
			occurredAt: new Date(result[0].occurredAt),
			id: result[0].id
		});
	});

	it('rejects a malformed `after` cursor with TransactionCursorError (→400/422), not silently', async () => {
		// Access + settlement selects succeed; the decode happens while building the
		// WHERE, so it throws from inside the real listTransactions path.
		queueSelects(ACCESS_OK, SETTLEMENT_ROW);
		await expect(
			listTransactions({ userId: 'u1', groupId: 'g1', filters: { after: 'not-a-cursor!!' } })
		).rejects.toBeInstanceOf(TransactionCursorError);
	});

	it('accepts a valid `after` + from/to filters and still shapes rows (builder wiring)', async () => {
		queueSelects(ACCESS_OK, SETTLEMENT_ROW, ROWS);
		const after = encodeTransactionCursor({
			createdAt: new Date('2026-03-02T00:00:00.000Z'),
			occurredAt: new Date('2026-03-02T00:00:00.000Z'),
			id: 't9'
		});
		const result = await listTransactions({
			userId: 'u1',
			groupId: 'g1',
			filters: {
				after,
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-12-31T23:59:59.999Z')
			}
		});
		expect(result).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// §16.4 keyset pagination — cursor codec + ordering/range boundary math.
// ─────────────────────────────────────────────────────────────────────────────

describe('transaction cursor codec (PLAN §16.4)', () => {
	const key: TransactionCursorKey = {
		createdAt: new Date('2026-03-01T00:00:00.000Z'),
		occurredAt: new Date('2026-03-01T08:30:00.000Z'),
		id: 'txn_abc'
	};

	it('round-trips a sort key through encode → decode', () => {
		expect(decodeTransactionCursor(encodeTransactionCursor(key))).toEqual(key);
	});

	it('produces an OPAQUE cursor (base64url; does not leak the raw id/dates)', () => {
		const cursor = encodeTransactionCursor(key);
		// URL-safe base64: no raw payload, no `+`/`/`/`=` padding chars.
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(cursor).not.toContain('txn_abc');
	});

	it.each([
		['empty', ''],
		['non-base64url junk', 'not a cursor !!!'],
		['base64 of non-JSON', Buffer.from('hello', 'utf8').toString('base64url')],
		['base64 of a non-array', Buffer.from('{"a":1}', 'utf8').toString('base64url')],
		[
			'wrong tuple length',
			Buffer.from('["2026-03-01T00:00:00.000Z"]', 'utf8').toString('base64url')
		],
		[
			'invalid date',
			Buffer.from('["nope","2026-03-01T00:00:00.000Z","id"]', 'utf8').toString('base64url')
		],
		[
			'empty id',
			Buffer.from('["2026-03-01T00:00:00.000Z","2026-03-01T00:00:00.000Z",""]', 'utf8').toString(
				'base64url'
			)
		],
		[
			'non-string id',
			Buffer.from('["2026-03-01T00:00:00.000Z","2026-03-01T00:00:00.000Z",5]', 'utf8').toString(
				'base64url'
			)
		]
	])('throws TransactionCursorError on a malformed cursor (%s)', (_label, bad) => {
		expect(() => decodeTransactionCursor(bad)).toThrow(TransactionCursorError);
	});
});

describe('keyset pagination boundary (PLAN §16.4 — no dup/skip, id tie-break)', () => {
	// A fixture spanning the tricky cases: distinct dates, a same-`createdAt`/
	// different-`occurredAt` pair, AND two rows sharing BOTH createdAt+occurredAt
	// (only `id` separates them — the reason `id` must be in the total order).
	const D = (s: string) => new Date(s);
	const universe: TransactionCursorKey[] = [
		{ createdAt: D('2026-03-03T00:00:00Z'), occurredAt: D('2026-03-03T09:00:00Z'), id: 'a' },
		{ createdAt: D('2026-03-02T00:00:00Z'), occurredAt: D('2026-03-02T10:00:00Z'), id: 'b' },
		{ createdAt: D('2026-03-02T00:00:00Z'), occurredAt: D('2026-03-02T08:00:00Z'), id: 'c' },
		// Tie on BOTH timestamps — distinguished only by id (DESC: 'e' before 'd').
		{ createdAt: D('2026-03-01T00:00:00Z'), occurredAt: D('2026-03-01T12:00:00Z'), id: 'e' },
		{ createdAt: D('2026-03-01T00:00:00Z'), occurredAt: D('2026-03-01T12:00:00Z'), id: 'd' },
		{ createdAt: D('2026-02-28T00:00:00Z'), occurredAt: D('2026-02-28T00:00:00Z'), id: 'f' }
	];

	/** The canonical §16.4 total order: createdAt DESC, occurredAt DESC, id DESC. */
	function totalOrder(rows: TransactionCursorKey[]): TransactionCursorKey[] {
		return [...rows].sort((x, y) => {
			if (x.createdAt.getTime() !== y.createdAt.getTime())
				return y.createdAt.getTime() - x.createdAt.getTime();
			if (x.occurredAt.getTime() !== y.occurredAt.getTime())
				return y.occurredAt.getTime() - x.occurredAt.getTime();
			return x.id < y.id ? 1 : x.id > y.id ? -1 : 0;
		});
	}

	/** Simulate a keyset page: rows strictly after `cursor`, in order, capped at `limit`. */
	function page(cursor: TransactionCursorKey | null, limit: number): TransactionCursorKey[] {
		const ordered = totalOrder(universe);
		const eligible = cursor ? ordered.filter((r) => rowIsAfterCursor(r, cursor)) : ordered;
		return eligible.slice(0, limit);
	}

	it('ordered universe places the id tie-break rows in DESC id order (e before d)', () => {
		const ids = totalOrder(universe).map((r) => r.id);
		expect(ids).toEqual(['a', 'b', 'c', 'e', 'd', 'f']);
	});

	it('paginating page-by-page covers every row exactly once (no gap, no duplicate)', () => {
		const LIMIT = 2;
		const seen: string[] = [];
		let cursor: TransactionCursorKey | null = null;
		// Bound the loop defensively so a bug can't spin forever.
		for (let guard = 0; guard < 100; guard++) {
			const rows = page(cursor, LIMIT);
			if (rows.length === 0) break;
			seen.push(...rows.map((r) => r.id));
			const last = rows[rows.length - 1];
			// Mint the next cursor exactly as the API layer will: from the last row's key.
			cursor = decodeTransactionCursor(encodeTransactionCursor(last));
		}
		// Every id, once, in the exact total order — the id tie-break pair (e,d) crosses
		// a page boundary here (page 2 = [c, e], page 3 = [d, f]) yet neither repeats
		// nor is skipped.
		expect(seen).toEqual(['a', 'b', 'c', 'e', 'd', 'f']);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it('the cursor at an id-tie row advances PAST it without re-emitting its tie-mate', () => {
		// Cursor sits on 'e' (the first of the createdAt+occurredAt tie pair). The next
		// page must start at 'd' (its lower-id tie-mate), never re-include 'e'.
		const e = universe.find((r) => r.id === 'e')!;
		const next = page(e, 10).map((r) => r.id);
		expect(next).toEqual(['d', 'f']);
		expect(next).not.toContain('e');
	});
});

describe('from/to date-range inclusivity (PLAN §16.4 / §7.1 createdAt)', () => {
	const from = new Date('2026-03-01T00:00:00.000Z');
	const to = new Date('2026-03-31T23:59:59.999Z');

	it('includes a row exactly on the `from` bound (inclusive lower)', () => {
		expect(createdAtInRange(new Date(from), from, to)).toBe(true);
	});

	it('includes a row exactly on the `to` bound (inclusive upper)', () => {
		expect(createdAtInRange(new Date(to), from, to)).toBe(true);
	});

	it('excludes a row 1ms before `from` and 1ms after `to`', () => {
		expect(createdAtInRange(new Date(from.getTime() - 1), from, to)).toBe(false);
		expect(createdAtInRange(new Date(to.getTime() + 1), from, to)).toBe(false);
	});

	it('treats each bound as independently optional (open-ended range)', () => {
		const d = new Date('2020-01-01T00:00:00.000Z');
		expect(createdAtInRange(d, undefined, undefined)).toBe(true);
		expect(createdAtInRange(d, from, undefined)).toBe(false); // below open `from`
		expect(createdAtInRange(d, undefined, to)).toBe(true); // under open `to`
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 4.11 — view/edit + soft-delete/restore (PLAN §7.1, §7.2, §7.6, §9, §12.1).
// ─────────────────────────────────────────────────────────────────────────────

const SETTLEMENT_THB = [{ settlementCurrency: 'THB' }];

/** A persisted same-currency (THB) equal-split spending txn row (live). */
function txnRow(over: Record<string, unknown> = {}) {
	return [
		{
			id: 't1',
			groupId: 'g1',
			type: 'spending',
			title: 'Dinner',
			categoryId: 'spending-food-drink',
			amountTotal: 9000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 9000,
			splitMode: 'equal',
			createdAt: new Date('2026-02-01T00:00:00.000Z'),
			deletedAt: null,
			...over
		}
	];
}

describe('getTransactionDetail — reconstruction round-trips (PLAN §7.2/§7.6)', () => {
	it('throws TransactionNotFoundError (→404) when the txn is not in this group; no writes', async () => {
		// access ok → settlement currency → txn row EMPTY (wrong group / bogus id).
		queueSelects(ACCESS_OK, SETTLEMENT_THB, []);
		await expect(
			getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 'nope' })
		).rejects.toBeInstanceOf(TransactionNotFoundError);
		expect(inserts).toHaveLength(0);
	});

	it('throws GroupAccessError (→404) when access is denied', async () => {
		queueSelects([]); // access check fails
		await expect(
			getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 't1' })
		).rejects.toBeInstanceOf(GroupAccessError);
	});

	it('reconstructs an EQUAL split input (round-trips the original)', async () => {
		// access → settlement → txn → payers → shares → items(none) → charges(none).
		queueSelects(
			ACCESS_OK,
			SETTLEMENT_THB,
			txnRow(),
			[{ memberId: 'm1', amountPaid: 9000 }],
			[
				{ memberId: 'm1', amountOwed: 4500, shareWeight: null, rawAmount: null },
				{ memberId: 'm2', amountOwed: 4500, shareWeight: null, rawAmount: null }
			],
			[], // no items
			[] // no charges
		);
		const detail = await getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(detail.deletedAt).toBeNull();
		expect(detail.input).toEqual({
			type: 'spending',
			title: 'Dinner',
			// Reconstructed from created_at (the txnRow fixture's 2026-02-01) as a YYYY-MM-DD day.
			date: '2026-02-01',
			categoryId: 'spending-food-drink',
			amountTotal: 9000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 9000,
			splitMode: 'equal',
			payers: [{ memberId: 'm1', amountPaid: 9000 }],
			beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }],
			items: [],
			charges: []
		});
		// The reconstructed input re-validates byte-identically with the shared schema.
		const schema = buildTransactionSchema({ settlementCurrency: 'THB', memberIds: ['m1', 'm2'] });
		expect(schema.safeParse(detail.input).success).toBe(true);
		// And the view carries the resolved settlement shares + entry currency.
		expect(detail.shares).toEqual([
			{ memberId: 'm1', amountOwed: 4500 },
			{ memberId: 'm2', amountOwed: 4500 }
		]);
		expect(detail.currency).toBe('THB');
		expect(detail.isForeign).toBe(false);
	});

	it('reconstructs an AMOUNT split (raw_amount preserved per member)', async () => {
		queueSelects(
			ACCESS_OK,
			SETTLEMENT_THB,
			txnRow({ splitMode: 'amount' }),
			[{ memberId: 'm1', amountPaid: 9000 }],
			[
				{ memberId: 'm1', amountOwed: 2000, shareWeight: null, rawAmount: 2000 },
				{ memberId: 'm2', amountOwed: 7000, shareWeight: null, rawAmount: 7000 }
			],
			[],
			[]
		);
		const detail = await getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(detail.input.splitMode).toBe('amount');
		expect(detail.input.beneficiaries).toEqual([
			{ memberId: 'm1', rawAmount: 2000 },
			{ memberId: 'm2', rawAmount: 7000 }
		]);
	});

	it('reconstructs a SHARE split (share_weight preserved per member)', async () => {
		queueSelects(
			ACCESS_OK,
			SETTLEMENT_THB,
			txnRow({ splitMode: 'share' }),
			[{ memberId: 'm1', amountPaid: 9000 }],
			[
				{ memberId: 'm1', amountOwed: 3000, shareWeight: 1, rawAmount: null },
				{ memberId: 'm2', amountOwed: 6000, shareWeight: 2, rawAmount: null }
			],
			[],
			[]
		);
		const detail = await getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(detail.input.splitMode).toBe('share');
		expect(detail.input.beneficiaries).toEqual([
			{ memberId: 'm1', shareWeight: 1 },
			{ memberId: 'm2', shareWeight: 2 }
		]);
	});

	it('reconstructs an ITEMIZED + charges input (per-item mode/inputs + charges preserved)', async () => {
		// Two items (Pizza equal m1/m2; Wine share m1:1/m2:2) + service 10% + flat 5 discount.
		queueSelects(
			ACCESS_OK,
			SETTLEMENT_THB,
			txnRow({ splitMode: 'itemized', amountTotal: 116, amountTotalSettlement: 116 }),
			[{ memberId: 'm1', amountPaid: 116 }],
			[
				{ memberId: 'm1', amountOwed: 56, shareWeight: null, rawAmount: null },
				{ memberId: 'm2', amountOwed: 60, shareWeight: null, rawAmount: null }
			],
			// items (ordered by sort_order)
			[
				{ id: 'i0', label: 'Pizza', amount: 100, sortOrder: 0 },
				{ id: 'i1', label: 'Wine', amount: 10, sortOrder: 1 }
			],
			// item-shares (all of them; grouped by item_id in the service)
			[
				{
					itemId: 'i0',
					memberId: 'm1',
					amountOwed: 50,
					splitMode: 'equal',
					shareWeight: null,
					rawAmount: null
				},
				{
					itemId: 'i0',
					memberId: 'm2',
					amountOwed: 50,
					splitMode: 'equal',
					shareWeight: null,
					rawAmount: null
				},
				{
					itemId: 'i1',
					memberId: 'm1',
					amountOwed: 3,
					splitMode: 'share',
					shareWeight: 1,
					rawAmount: null
				},
				{
					itemId: 'i1',
					memberId: 'm2',
					amountOwed: 7,
					splitMode: 'share',
					shareWeight: 2,
					rawAmount: null
				}
			],
			// charges (ordered by sort_order)
			[
				{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
				{ kind: 'discount', mode: 'absolute', value: 5, base: 'running_total', sortOrder: 1 }
			]
		);
		const detail = await getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(detail.input.splitMode).toBe('itemized');
		expect(detail.input.beneficiaries).toEqual([]);
		expect(detail.input.items).toEqual([
			{
				label: 'Pizza',
				amount: 100,
				splitMode: 'equal',
				beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }]
			},
			{
				label: 'Wine',
				amount: 10,
				splitMode: 'share',
				beneficiaries: [
					{ memberId: 'm1', shareWeight: 1 },
					{ memberId: 'm2', shareWeight: 2 }
				]
			}
		]);
		expect(detail.input.charges).toEqual([
			{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'discount', mode: 'absolute', value: 5, base: 'running_total', sortOrder: 1 }
		]);
		// The reconstructed itemized+charges input re-validates (amount_total math holds).
		const schema = buildTransactionSchema({ settlementCurrency: 'THB', memberIds: ['m1', 'm2'] });
		expect(schema.safeParse(detail.input).success).toBe(true);
	});

	it('reconstructs a FOREIGN-currency txn preserving currency + exchange_rate (§7.6)', async () => {
		// CN¥90.00 equal split in a THB group @4.85 → settlement 43650.
		queueSelects(
			ACCESS_OK,
			SETTLEMENT_THB,
			txnRow({ currency: 'CNY', exchangeRate: '4.85', amountTotalSettlement: 43650 }),
			[{ memberId: 'm1', amountPaid: 9000 }],
			[
				{ memberId: 'm1', amountOwed: 21825, shareWeight: null, rawAmount: null },
				{ memberId: 'm2', amountOwed: 21825, shareWeight: null, rawAmount: null }
			],
			[],
			[]
		);
		const detail = await getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(detail.currency).toBe('CNY');
		expect(detail.isForeign).toBe(true);
		expect(detail.input.currency).toBe('CNY');
		expect(detail.input.exchangeRate).toBe('4.85');
		expect(detail.input.amountTotal).toBe(9000); // CNY entry minor
		expect(detail.input.amountTotalSettlement).toBe(43650);
		// Round-trips through the schema (FX scalar check passes).
		const schema = buildTransactionSchema({ settlementCurrency: 'THB', memberIds: ['m1', 'm2'] });
		expect(schema.safeParse(detail.input).success).toBe(true);
	});

	it('still returns a SOFT-DELETED txn (so it can be restored), marked deleted', async () => {
		const deletedAt = new Date('2026-03-01T00:00:00.000Z');
		queueSelects(
			ACCESS_OK,
			SETTLEMENT_THB,
			txnRow({ deletedAt }),
			[{ memberId: 'm1', amountPaid: 9000 }],
			[
				{ memberId: 'm1', amountOwed: 4500, shareWeight: null, rawAmount: null },
				{ memberId: 'm2', amountOwed: 4500, shareWeight: null, rawAmount: null }
			],
			[],
			[]
		);
		const detail = await getTransactionDetail({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(detail.deletedAt).toBe(deletedAt.toISOString());
		expect(detail.title).toBe('Dinner');
	});
});

describe('updateTransaction — re-resolve + replace children + audit (PLAN §7.1, §12.1)', () => {
	// SELECT order inside the tx (settlementCurrency PASSED, so loadSettlementCurrency
	// is skipped): access → load txn (title,deletedAt) → activeMembers → category
	// existence → deleteTransactionChildren item-id lookup.
	function queueEditSelects(opts: { deletedAt?: Date | null; itemIds?: { id: string }[] } = {}) {
		queueSelects(
			ACCESS_OK,
			[{ title: 'Dinner', deletedAt: opts.deletedAt ?? null }],
			ACTIVE_MEMBERS,
			CATEGORY_ROW,
			opts.itemIds ?? [] // existing item ids to delete (none for a non-itemized txn)
		);
	}

	it('updates the txn row (occurred_at untouched, updated_at bumped, created_at from input)', async () => {
		queueEditSelects();
		const when = new Date('2026-05-05T05:05:05.000Z');
		await updateTransaction({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1',
			input: { ...equalInput(), title: 'Lunch', date: '2026-01-02' },
			settlementCurrency: 'THB',
			now: () => when
		});

		const txnUpdate = updatesTo('transactions');
		expect(txnUpdate).toHaveLength(1);
		const set = txnUpdate[0].values;
		expect(set.title).toBe('Lunch');
		// created_at = the editable real-world date (noon UTC of the picked day),
		// DECOUPLED from updated_at which is the real edit-time `now()`.
		expect((set.createdAt as Date).toISOString()).toBe('2026-01-02T12:00:00.000Z');
		expect(set.updatedAt).toBe(when);
		// occurred_at is IMMUTABLE — never written on edit (§7.1).
		expect('occurredAt' in set).toBe(false);
		// Everything through the SAME open tx handle (§12.1).
		expect((txnUpdate[0].via as { name: string }).name).toBe('tx');
	});

	it('deletes ALL existing child rows then re-inserts the freshly resolved ones', async () => {
		queueEditSelects();
		await updateTransaction({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1',
			input: equalInput(),
			settlementCurrency: 'THB'
		});
		// Children replaced: payers + shares + items + charges deleted (item-shares only
		// when there were items — none here). Then re-inserted.
		expect(deletesTo('transaction_payers')).toHaveLength(1);
		expect(deletesTo('transaction_shares')).toHaveLength(1);
		expect(deletesTo('transaction_items')).toHaveLength(1);
		expect(deletesTo('transaction_charges')).toHaveLength(1);
		// Re-inserted resolved rows (no transactions INSERT on edit — it's an update).
		expect(insertsTo('transactions')).toHaveLength(0);
		expect(insertsTo('transaction_payers')).toHaveLength(1);
		expect(insertsTo('transaction_shares')).toHaveLength(2);
		// All deletes + inserts + the audit went through the SAME tx handle (§12.1).
		expect(deletes.every((d) => (d.via as { name: string }).name === 'tx')).toBe(true);
		expect(inserts.every((i) => (i.via as { name: string }).name === 'tx')).toBe(true);
	});

	it('RE-RESOLVES settlement amounts server-side (does not trust client share values)', async () => {
		queueEditSelects();
		await updateTransaction({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1',
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
		const expected = resolveShares({
			splitMode: 'share',
			amountTotal: 9000,
			beneficiaries: [
				{ memberId: 'm1', shareWeight: 1 },
				{ memberId: 'm2', shareWeight: 2 }
			]
		});
		const shareRows = insertsTo('transaction_shares').map((i) => ({
			memberId: i.values.memberId,
			amountOwed: i.values.amountOwed
		}));
		expect(shareRows).toEqual(
			expected.map((e) => ({ memberId: e.memberId, amountOwed: e.amountOwed }))
		);
		expect(shareRows).toEqual([
			{ memberId: 'm1', amountOwed: 3000 },
			{ memberId: 'm2', amountOwed: 6000 }
		]);
	});

	it('writes an `edit` audit row (entity=transaction) through the SAME tx', async () => {
		queueEditSelects();
		await updateTransaction({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1',
			input: { ...equalInput(), title: 'Lunch' },
			settlementCurrency: 'THB'
		});
		const audit = insertsTo('audit_log');
		expect(audit).toHaveLength(1);
		expect(audit[0].values.action).toBe('edit');
		expect(audit[0].values.entityType).toBe('transaction');
		expect(audit[0].values.entityId).toBe('t1');
		expect(String(audit[0].values.summary)).toContain('Lunch');
		expect((audit[0].via as { name: string }).name).toBe('tx');
	});

	it('deletes item-shares per existing item id when the txn HAD items', async () => {
		queueEditSelects({ itemIds: [{ id: 'old-i0' }, { id: 'old-i1' }] });
		await updateTransaction({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1',
			input: equalInput(),
			settlementCurrency: 'THB'
		});
		// One item-shares delete per existing item id (keyed by item_id).
		expect(deletesTo('transaction_item_shares')).toHaveLength(2);
	});

	it('REFUSES to edit a soft-deleted txn (TransactionDeletedError); no writes', async () => {
		queueEditSelects({ deletedAt: new Date('2026-03-01T00:00:00.000Z') });
		await expect(
			updateTransaction({
				userId: 'u1',
				groupId: 'g1',
				txnId: 't1',
				input: equalInput(),
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionDeletedError);
		expect(updates).toHaveLength(0);
		expect(inserts).toHaveLength(0);
		expect(deletes).toHaveLength(0);
	});

	it('rejects invalid input with TransactionValidationError; no writes', async () => {
		queueEditSelects();
		await expect(
			updateTransaction({
				userId: 'u1',
				groupId: 'g1',
				txnId: 't1',
				input: { ...equalInput(), payers: [{ memberId: 'm1', amountPaid: 1 }] },
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionValidationError);
		expect(updates).toHaveLength(0);
		expect(inserts).toHaveLength(0);
	});

	it('throws TransactionNotFoundError when the txn is not in this group; no writes', async () => {
		queueSelects(ACCESS_OK, []); // access ok, but no txn row
		await expect(
			updateTransaction({
				userId: 'u1',
				groupId: 'g1',
				txnId: 'nope',
				input: equalInput(),
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(TransactionNotFoundError);
		expect(updates).toHaveLength(0);
	});

	it('access denied → GroupAccessError, no writes', async () => {
		queueSelects([]); // access fails
		await expect(
			updateTransaction({
				userId: 'u1',
				groupId: 'g1',
				txnId: 't1',
				input: equalInput(),
				settlementCurrency: 'THB'
			})
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(updates).toHaveLength(0);
		expect(inserts).toHaveLength(0);
	});
});

describe('softDeleteTransaction / restoreTransaction (PLAN §9, §12.1)', () => {
	it('soft-delete sets deleted_at + writes a `delete` audit through the SAME tx', async () => {
		// access → load txn (title,deletedAt).
		queueSelects(ACCESS_OK, [{ title: 'Dinner', deletedAt: null }]);
		const when = new Date('2026-06-01T00:00:00.000Z');
		await softDeleteTransaction({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1',
			now: () => when
		});
		const upd = updatesTo('transactions');
		expect(upd).toHaveLength(1);
		expect(upd[0].values.deletedAt).toBe(when);
		const audit = insertsTo('audit_log');
		expect(audit).toHaveLength(1);
		expect(audit[0].values.action).toBe('delete');
		expect(audit[0].values.entityType).toBe('transaction');
		// Same tx handle → the audit row commits/rolls back WITH the soft-delete (§12.1).
		expect((upd[0].via as { name: string }).name).toBe('tx');
		expect((audit[0].via as { name: string }).name).toBe('tx');
	});

	it('restore clears deleted_at + writes a `restore` audit through the SAME tx', async () => {
		queueSelects(ACCESS_OK, [{ title: 'Dinner', deletedAt: new Date() }]);
		await restoreTransaction({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		const upd = updatesTo('transactions');
		expect(upd).toHaveLength(1);
		expect(upd[0].values.deletedAt).toBeNull();
		const audit = insertsTo('audit_log');
		expect(audit).toHaveLength(1);
		expect(audit[0].values.action).toBe('restore');
		expect((audit[0].via as { name: string }).name).toBe('tx');
	});

	it('both are access-checked → GroupAccessError, no writes', async () => {
		queueSelects([]); // access fails
		await expect(
			softDeleteTransaction({ userId: 'u1', groupId: 'g1', txnId: 't1' })
		).rejects.toBeInstanceOf(GroupAccessError);
		queueSelects([]);
		await expect(
			restoreTransaction({ userId: 'u1', groupId: 'g1', txnId: 't1' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(updates).toHaveLength(0);
		expect(inserts).toHaveLength(0);
	});

	it('not-found (wrong group / bogus id) → TransactionNotFoundError, no writes', async () => {
		queueSelects(ACCESS_OK, []); // access ok, no txn row
		await expect(
			softDeleteTransaction({ userId: 'u1', groupId: 'g1', txnId: 'nope' })
		).rejects.toBeInstanceOf(TransactionNotFoundError);
		expect(updates).toHaveLength(0);
		expect(inserts).toHaveLength(0);
	});

	it('the audit trail is written independent of the soft-delete (append-only, outlives it)', async () => {
		// A soft-delete followed by a restore both append their own audit rows — neither
		// removes prior history (§12.1: append-only, outlives the soft-delete).
		queueSelects(ACCESS_OK, [{ title: 'Dinner', deletedAt: null }]);
		await softDeleteTransaction({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(insertsTo('audit_log')).toHaveLength(1);
		inserts.length = 0;
		updates.length = 0;
		queueSelects(ACCESS_OK, [{ title: 'Dinner', deletedAt: new Date() }]);
		await restoreTransaction({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		const audit = insertsTo('audit_log');
		expect(audit).toHaveLength(1);
		expect(audit[0].values.action).toBe('restore');
	});
});
