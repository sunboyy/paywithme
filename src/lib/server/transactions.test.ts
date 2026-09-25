import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the transaction service's READ side (listing, cursors, detail
// reconstruction) and for the row locks its writes take.
//
// STRATEGY: NO real DB — a small fluent query-builder stub. We PROGRAM what each
// SELECT resolves to, in order, and RECORD every `.for(...)` lock strength. The
// write paths' behaviour is tested against a real Postgres in
// `tests/integration/transaction-writes.test.ts`.

// --- Fluent DB mock -------------------------------------------------------
const {
	selectQueue,
	inserts,
	updates,
	deletes,
	updateReturningQueue,
	groupRoundingSeq,
	selectLocks,
	makeDb,
	lastTxHandle
} = vi.hoisted(() => {
	const selectQueue: unknown[][] = [];
	// Records: which table + values for every insert, plus the tx handle used.
	const inserts: { table: string; values: Record<string, unknown>; via: object }[] = [];
	// Records: which table + the .set() values for every update, plus the tx handle.
	const updates: { table: string; values: Record<string, unknown>; via: object }[] = [];
	// Records: which table was deleted from, plus the tx handle.
	const deletes: { table: string; via: object }[] = [];
	// Row-sets the NEXT update `.returning()` resolves to (rows-affected count). Empty
	// → default to ONE affected row so a real state transition writes its audit; push
	// `[]` to simulate a NO-OP update (0 rows affected → audit gated off, §16.6).
	const updateReturningQueue: unknown[][] = [];
	const lastTxHandle: { current: object | null } = { current: null };
	// Stands in for `groups.next_rounding_seq` (ADR-0013). The service allocates a
	// transaction's rounding ordinal by incrementing this and reading it back, so
	// the mock has to behave like a counter, not like a rows-affected result.
	const groupRoundingSeq = { current: 0 };
	// Every row-lock strength requested via `.for(...)`, in order.
	const selectLocks: string[] = [];

	function nextSelectRows(): unknown[] {
		return selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
	}

	function selectChain() {
		const rows = nextSelectRows();
		const chain: Record<string, unknown> = {};
		const methods = ['from', 'innerJoin', 'where', 'limit', 'orderBy'];
		for (const m of methods) chain[m] = () => chain;
		// `.for(strength)` = the `SELECT … FOR UPDATE/SHARE` row lock. Recorded rather
		// than ignored: the exponent freeze (issue #69 finding 1) IS the lock the
		// entry-currency read takes, so a test has to be able to see it — and to see
		// that the seeded fast path takes none.
		chain.for = (strength: string) => {
			selectLocks.push(strength);
			return chain;
		};
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
				// `.returning()` resolves to the rows-affected set (softDelete/restore read
				// its length to gate the audit write, §16.6). Default: ONE affected row.
				//
				// EXCEPT on `groups`, where the only update the service makes is the
				// rounding-ordinal allocation (ADR-0013) — an atomic increment that reads
				// its POST-increment value back. Standing in a real counter here (rather
				// than a generic "one row affected") is what lets every create test keep
				// working untouched, and lets the rotation tests below observe successive
				// creates receiving successive ordinals.
				chain.returning = () => {
					if (updateReturningQueue.length > 0) {
						return Promise.resolve(updateReturningQueue.shift() as unknown[]);
					}
					if (tableName(table) === 'groups') {
						groupRoundingSeq.current += 1;
						return Promise.resolve([{ nextRoundingSeq: groupRoundingSeq.current }]);
					}
					return Promise.resolve([{ id: 'affected' }]);
				};
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

	return {
		selectQueue,
		inserts,
		updates,
		deletes,
		updateReturningQueue,
		groupRoundingSeq,
		selectLocks,
		makeDb: () => db,
		lastTxHandle
	};
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
	TransactionNotFoundError,
	TransactionCursorError,
	encodeTransactionCursor,
	decodeTransactionCursor,
	rowIsAfterCursor,
	createdAtInRange,
	type TransactionCursorKey
} from './transactions';
import { GroupAccessError } from './groups';
import { buildTransactionSchema } from '$lib/schemas/transaction';

/** Queue the row-sets each successive SELECT chain resolves to. */
function queueSelects(...rowSets: unknown[][]) {
	selectQueue.length = 0;
	selectQueue.push(...rowSets);
}

const ACCESS_OK = [{ id: 'access-member' }];
const ACTIVE_MEMBERS = [{ id: 'm1' }, { id: 'm2' }];
const NAMED_MEMBERS = [
	{ id: 'm1', displayName: 'Alice' },
	{ id: 'm2', displayName: 'Bob' }
];
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

beforeEach(() => {
	inserts.length = 0;
	updates.length = 0;
	deletes.length = 0;
	updateReturningQueue.length = 0;
	selectQueue.length = 0;
	selectLocks.length = 0;
	lastTxHandle.current = null;
	groupRoundingSeq.current = 0;
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
			createdBy: 'u1',
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
			createdBy: 'u1',
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
			createdBy: 'u1',
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
			createdBy: 'u1',
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

	it('accepts the member filter alongside every other filter (builder wiring)', async () => {
		// This stub can't introspect the WHERE — the SQL SHAPE of the member predicate
		// is asserted in `transactions-member-filter.test.ts` (real tables + PgDialect)
		// and its row semantics in `tests/integration/transaction-member-filter.test.ts`.
		// What's checked HERE is that the filter composes with the others without
		// disturbing the query build or the row shaping.
		for (const memberRole of [undefined, 'paid', 'owes'] as const) {
			queueSelects(ACCESS_OK, SETTLEMENT_ROW, ROWS);
			const result = await listTransactions({
				userId: 'u1',
				groupId: 'g1',
				filters: {
					type: 'spending',
					categoryId: 'spending-food-drink',
					memberId: 'm1',
					memberRole,
					from: new Date('2026-01-01T00:00:00.000Z'),
					to: new Date('2026-12-31T23:59:59.999Z')
				}
			});
			// One row per transaction — a member filter must never fan rows out.
			expect(result).toHaveLength(2);
			expect(result.map((r) => r.id)).toEqual(['t1', 't2']);
		}
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

// The write paths (create / update / delete / restore) are tested against a real
// Postgres in `tests/integration/transaction-writes.test.ts`. What stays here is
// the one thing only a query-level stub can see: which row locks a write takes.

const READ_BACK_TXN = {
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
	createdBy: 'u1',
	createdAt: new Date('2026-01-02T12:00:00.000Z'),
	deletedAt: null
};

/** The SELECTs a write's read-back makes: settlement currency, the row, then its (empty) children. */
const READ_BACK = [[{ settlementCurrency: 'THB' }], [READ_BACK_TXN], [], [], [], []];

const BEER_ROW = { code: 'cur_beer', displayCode: 'BEER', exponent: 0, symbol: '🍺' };
const THREE_MEMBERS = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];

/** 7 BEER at ฿250 = ฿1,750.00, split equally between m1/m2/m3. */
function beerInput() {
	return {
		...equalInput(),
		amountTotal: 7,
		currency: BEER_ROW.code,
		currencyExponent: BEER_ROW.exponent,
		exchangeRate: '250',
		amountTotalSettlement: 175_000,
		payers: [{ memberId: 'm1', amountPaid: 7 }],
		beneficiaries: [{ memberId: 'm1' }, { memberId: 'm2' }, { memberId: 'm3' }]
	};
}

describe('row locks a write takes', () => {
	it('a SEEDED-currency create with no name snapshot takes NO lock', async () => {
		queueSelects(ACCESS_OK, ACTIVE_MEMBERS, CATEGORY_ROW, ...READ_BACK);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: equalInput(),
			settlementCurrency: 'THB'
		});
		expect(selectLocks).toEqual([]);
	});

	it('LOCKS the custom currency rows `FOR SHARE` on create (issue #69 finding 1)', async () => {
		// The exponent this read returns is what every amount is computed with, and the
		// referencing row is inserted later in the SAME transaction. `FOR SHARE` makes a
		// concurrent `updateCustomCurrency` (`FOR UPDATE`) wait for us.
		queueSelects(ACCESS_OK, THREE_MEMBERS, [BEER_ROW], CATEGORY_ROW, ...READ_BACK);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: beerInput(),
			settlementCurrency: 'THB'
		});
		expect(selectLocks).toEqual(['share']);
	});

	it('LOCKS the active members `FOR SHARE` only when there is a name snapshot (PR #80 review)', async () => {
		// A concurrent `renameMember` (a row-exclusive UPDATE) must wait for the write
		// that checked the names; a write that resolved no name has nothing to protect.
		queueSelects(ACCESS_OK, NAMED_MEMBERS, CATEGORY_ROW, ...READ_BACK);
		await createTransaction({
			userId: 'u1',
			groupId: 'g1',
			input: equalInput(),
			settlementCurrency: 'THB',
			expectedMemberNames: new Map([
				['m1', 'Alice'],
				['m2', 'Bob']
			])
		});
		expect(selectLocks).toEqual(['share']);
	});

	it('an edit locks the transaction row `FOR UPDATE` first, then the custom currency rows (#94)', async () => {
		queueSelects(
			ACCESS_OK,
			[{ title: 'Beers', deletedAt: null, roundingSeq: 2 }],
			...READ_BACK,
			THREE_MEMBERS,
			[BEER_ROW],
			CATEGORY_ROW,
			[],
			...READ_BACK
		);
		await updateTransaction({
			userId: 'u1',
			groupId: 'g1',
			txnId: 't1',
			input: beerInput(),
			settlementCurrency: 'THB'
		});
		expect(selectLocks).toEqual(['update', 'share']);
	});

	it('delete and restore lock the transaction row `FOR UPDATE`', async () => {
		queueSelects(ACCESS_OK, [{ title: 'Dinner', deletedAt: null, roundingSeq: 0 }], ...READ_BACK);
		await softDeleteTransaction({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		queueSelects(ACCESS_OK, [{ title: 'Dinner', deletedAt: new Date() }], ...READ_BACK);
		await restoreTransaction({ userId: 'u1', groupId: 'g1', txnId: 't1' });
		expect(selectLocks).toEqual(['update', 'update']);
	});
});
