import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the Capture service (issue #49; PLAN §7.7, §12, §12.1; ADR-0012).
//
// STRATEGY (mirrors `currencies.test.ts`): there is NO real DB here — the real
// rollback, the real open/resolved/discarded WHERE and the real partial index are
// proved in `tests/integration/capture-service.test.ts`. What these tests pin down
// is the SERVICE LOGIC and its ORDER OF OPERATIONS:
//   - membership (§12) is asserted on ALL FOUR operations, BEFORE anything else —
//     including before the input is validated;
//   - a rejected mutation records NO audit insert at all (the same-transaction
//     write cannot have happened), and a FAILED insert records none either;
//   - the amount is stored EXACTLY as submitted — no rate, no conversion, no
//     settlement equivalent, and no extra column in the written row;
//   - resolve verifies the transaction belongs to THIS group first, and both
//     endings fail closed (already resolved / already discarded / not found);
//   - no `summary` the feed will render contains the internal word "capture";
//   - "open" is TWO ARMS (issue #91), and each reader runs them the way its indexes
//     need — pinned by compiling the predicate and every WHERE to SQL, which is the
//     one thing a fluent stub genuinely cannot fake. That a soft-deleted transaction
//     really does bring its note back is proved against a real database next door.
//
// The fluent stub records every insert/update and lets a test program what each
// table's SELECT resolves to, as a QUEUE.

const { state, calls, makeDb } = vi.hoisted(() => {
	const state = {
		/** table object → queue of row-sets, shifted one per `select().from(table)`. */
		selects: new Map<unknown, unknown[][]>(),
		/** table object → label for the ordered call log (registered below the imports). */
		names: new Map<unknown, string>(),
		/** Rows the next `insert(...).returning()` resolves to (else the values themselves). */
		insertReturning: [] as unknown[],
		/** Thrown by the next `insert(...).values(...)` when set. */
		insertError: null as unknown,
		/** Rows the next `update(...).returning()` resolves to. */
		updateReturning: [] as unknown[]
	};

	const calls = {
		/** Ordered log of DB operations, e.g. 'insert:captures'. */
		log: [] as string[],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		updates: [] as { table: unknown; set: Record<string, unknown>; where?: unknown }[],
		/** Every `innerJoin(table, on)` — the ON clause is compiled to SQL by a test. */
		joins: [] as { table: unknown; on: unknown }[],
		/** Every SELECT's `where(...)`, in order — compiled to SQL by the arm tests. */
		selectWheres: [] as unknown[]
	};

	function tableName(table: unknown): string {
		return state.names.get(table) ?? 'unknown';
	}

	function nextRows(table: unknown): unknown[] {
		const queue = state.selects.get(table);
		return queue && queue.length > 0 ? (queue.shift() as unknown[]) : [];
	}

	function selectChain() {
		const chain: Record<string, unknown> = {};
		let table: unknown;
		for (const m of ['limit', 'orderBy', 'groupBy', 'for']) {
			chain[m] = () => chain;
		}
		chain.where = (where: unknown) => {
			calls.selectWheres.push(where);
			return chain;
		};
		chain.innerJoin = (t: unknown, on: unknown) => {
			calls.joins.push({ table: t, on });
			return chain;
		};
		chain.from = (t: unknown) => {
			table = t;
			return chain;
		};
		chain.then = (resolve: (v: unknown) => unknown) => {
			calls.log.push(`select:${tableName(table)}`);
			return resolve(nextRows(table));
		};
		return chain;
	}

	function insertChain(table: unknown) {
		return {
			values(values: Record<string, unknown>) {
				calls.log.push(`insert:${tableName(table)}`);
				calls.inserts.push({ table, values });
				const settle = () => {
					if (state.insertError) {
						const e = state.insertError;
						state.insertError = null;
						return Promise.reject(e);
					}
					const rows = state.insertReturning.length > 0 ? state.insertReturning : [values];
					state.insertReturning = [];
					return Promise.resolve(rows);
				};
				return {
					returning: settle,
					then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
						settle().then(resolve, reject)
				};
			}
		};
	}

	function updateChain(table: unknown) {
		const chain: Record<string, unknown> = {};
		let record: { table: unknown; set: Record<string, unknown>; where?: unknown };
		chain.set = (values: Record<string, unknown>) => {
			calls.log.push(`update:${tableName(table)}`);
			record = { table, set: values };
			calls.updates.push(record);
			return chain;
		};
		chain.where = (where: unknown) => {
			record.where = where;
			return chain;
		};
		chain.returning = () => {
			const rows = state.updateReturning;
			state.updateReturning = [];
			return Promise.resolve(rows);
		};
		return chain;
	}

	const executor = {
		select: () => selectChain(),
		insert: (table: unknown) => insertChain(table),
		update: (table: unknown) => updateChain(table)
	};

	const db = {
		...executor,
		transaction: (cb: (tx: typeof executor) => Promise<unknown>) => cb(executor)
	};

	return { state, calls, makeDb: () => db };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

// The LEDGER side of a resolve. `recordCaptureAsTransaction` composes with the real
// `createTransaction` (issue #51), which is covered by its own suite + the real-DB
// integration tests; here it is a spy, so these tests can assert the two things the
// composition itself is responsible for: WHAT the ledger is handed, and that the
// stamp runs through the `tx` the ledger hands BACK.
const { createTransaction } = vi.hoisted(() => ({ createTransaction: vi.fn() }));
vi.mock('./transactions', async () => {
	const actual = await vi.importActual<typeof import('./transactions')>('./transactions');
	return { ...actual, createTransaction };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import {
	createCapture,
	listOpenCaptures,
	countOpenCapturesByGroup,
	openCapturePredicate,
	findOpenCapture,
	recordCaptureAsTransaction,
	resolveCapture,
	discardCapture,
	CaptureNotFoundError,
	CaptureNotOpenError,
	CaptureValidationError,
	type Capture
} from './captures';
import { db } from './db';
import { GroupAccessError } from './groups';
import { TransactionNotFoundError } from './transactions';
import { captures } from './db/captures-schema';
import { auditLog } from './db/audit-schema';
import { currencies } from './db/currencies-schema';
import { transactions } from './db/transactions-schema';
import { groups, members } from './db/groups-schema';

state.names.set(members, 'members');
state.names.set(groups, 'groups');
state.names.set(captures, 'captures');
state.names.set(currencies, 'currencies');
state.names.set(transactions, 'transactions');
state.names.set(auditLog, 'audit_log');

/** Program the rows the Nth `select().from(table)` resolves to (in order). */
function programSelects(table: unknown, ...rowSets: unknown[][]) {
	state.selects.set(table, rowSets);
}

/** Grant / deny the §12 membership check (a member row = access). */
function setAccess(granted: boolean) {
	programSelects(members, granted ? [{ id: 'm1' }] : []);
}

/** The recorded audit_log inserts. */
function auditInserts() {
	return calls.inserts.filter((c) => c.table === auditLog);
}

/** The Nth recorded UPDATE's WHERE clause, compiled to SQL. */
function updateWhere(n: number): string {
	const where = calls.updates[n].where as Parameters<PgDialect['sqlToQuery']>[0];
	return new PgDialect().sqlToQuery(where).sql;
}

/** A stored Capture row. */
function captureRow(overrides: Partial<Capture> = {}): Capture {
	return {
		id: 'cap-1',
		groupId: 'group-1',
		createdBy: 'user-42',
		note: 'dinner at the night market',
		amountMinor: null,
		currency: null,
		capturedFor: '2026-09-05',
		resolvedTransactionId: null,
		resolvedAt: null,
		discardedAt: null,
		createdAt: new Date('2026-09-05T12:00:00Z'),
		...overrides
	};
}

const ARGS = { userId: 'user-42', groupId: 'group-1' };

beforeEach(() => {
	state.selects.clear();
	state.insertReturning = [];
	state.insertError = null;
	state.updateReturning = [];
	calls.log.length = 0;
	calls.inserts.length = 0;
	calls.updates.length = 0;
	calls.joins.length = 0;
	calls.selectWheres.length = 0;
	createTransaction.mockReset();
});

describe('createCapture', () => {
	it('inserts the row and its audit entry in ONE transaction, in that order', async () => {
		setAccess(true);
		state.insertReturning = [captureRow()];

		const row = await createCapture({ ...ARGS, input: { note: 'dinner at the night market' } });

		expect(row.id).toBe('cap-1');
		// Membership FIRST, then the write, then the audit row — one unit of work.
		// (A seeded/absent currency issues no `select:currencies` at all.)
		expect(calls.log).toEqual(['select:members', 'insert:captures', 'insert:audit_log']);
		expect(auditInserts()).toHaveLength(1);
		expect(auditInserts()[0].values).toMatchObject({
			groupId: 'group-1',
			actorUserId: 'user-42',
			action: 'create',
			entityType: 'capture',
			entityId: 'cap-1',
			summary: "Noted 'dinner at the night market' as not recorded yet"
		});
	});

	it('derives the author and group SERVER-SIDE, ignoring anything submitted', async () => {
		setAccess(true);

		await createCapture({
			...ARGS,
			input: { note: 'dinner', createdBy: 'someone-else', groupId: 'another-group', id: 'forced' }
		});

		const values = calls.inserts.find((c) => c.table === captures)!.values;
		expect(values.createdBy).toBe('user-42');
		expect(values.groupId).toBe('group-1');
		expect(values).not.toHaveProperty('id');
	});

	it('stores the amount UNINTERPRETED — no rate, no conversion, no extra column', async () => {
		setAccess(true);

		await createCapture({
			...ARGS,
			input: {
				note: 'dinner',
				amountMinor: 120000,
				currency: 'THB',
				capturedFor: '2026-09-01',
				// Ledger shape a caller might try to smuggle in (ADR-0012).
				splitMode: 'equal',
				payers: [{ memberId: 'm1', amountPaid: 120000 }],
				exchangeRate: '0.0285'
			}
		});

		const values = calls.inserts.find((c) => c.table === captures)!.values;
		// EXACTLY as submitted: 120000 minor units of THB, untouched.
		expect(values.amountMinor).toBe(120000);
		expect(values.currency).toBe('THB');
		expect(Object.keys(values).sort()).toEqual([
			'amountMinor',
			'capturedFor',
			'createdBy',
			'currency',
			'groupId',
			'note'
		]);
	});

	it('writes NOTHING when the caller is not a member of the group (§12)', async () => {
		setAccess(false);

		await expect(createCapture({ ...ARGS, input: { note: 'dinner' } })).rejects.toBeInstanceOf(
			GroupAccessError
		);

		// Not even the validation ran: a non-member learns nothing from the errors.
		expect(calls.log).toEqual(['select:members']);
		expect(calls.inserts).toHaveLength(0);
	});

	it('rejects an invalid note WITHOUT writing anything', async () => {
		setAccess(true);

		await expect(createCapture({ ...ARGS, input: { note: '   ' } })).rejects.toBeInstanceOf(
			CaptureValidationError
		);

		expect(calls.inserts).toHaveLength(0);
	});

	it('rejects an amount with no currency, and a currency this group cannot use', async () => {
		setAccess(true);
		await expect(
			createCapture({ ...ARGS, input: { note: 'dinner', amountMinor: 120000 } })
		).rejects.toBeInstanceOf(CaptureValidationError);
		expect(calls.inserts).toHaveLength(0);

		setAccess(true);
		programSelects(currencies, []); // the group defines no custom currency
		await expect(
			createCapture({ ...ARGS, input: { note: 'dinner', amountMinor: 3, currency: 'cur_other' } })
		).rejects.toBeInstanceOf(CaptureValidationError);
		expect(calls.inserts).toHaveLength(0);
	});

	it("accepts the group's OWN custom currency, reading the set with ONE query", async () => {
		setAccess(true);
		programSelects(currencies, [{ code: 'cur_beer' }]);

		await createCapture({
			...ARGS,
			input: { note: 'a round', amountMinor: 3, currency: 'cur_beer' }
		});

		expect(calls.log).toEqual([
			'select:members',
			'select:currencies',
			'insert:captures',
			'insert:audit_log'
		]);
		expect(calls.inserts.find((c) => c.table === captures)!.values.currency).toBe('cur_beer');
	});

	it('leaves NO audit row behind when the capture insert itself fails (§12.1)', async () => {
		setAccess(true);
		state.insertError = new Error('insert exploded');

		await expect(createCapture({ ...ARGS, input: { note: 'dinner' } })).rejects.toThrow(
			'insert exploded'
		);

		// The audit write is downstream of the insert IN THE SAME transaction, so it
		// never even ran. (The real rollback — including the reverse case, an audit
		// failure undoing the capture — is proved against Postgres in the
		// integration suite.)
		expect(auditInserts()).toHaveLength(0);
	});

	it('carries credential provenance into the audit row (PLAN §16.2)', async () => {
		setAccess(true);
		state.insertReturning = [captureRow()];

		await createCapture({
			...ARGS,
			input: { note: 'dinner' },
			via: { keyId: 'key_1', keyName: 'My agent' }
		});

		const entry = auditInserts()[0].values;
		expect(entry.summary).toContain("(via API key 'My agent')");
		expect(entry.metadata).toMatchObject({ viaKey: 'key_1', keyName: 'My agent' });
		// The credential acts AS the user; it never becomes the actor.
		expect(entry.actorUserId).toBe('user-42');
	});
});

describe('listOpenCaptures', () => {
	it('reads the group tray only after the membership check', async () => {
		setAccess(true);
		const rows = [captureRow(), captureRow({ id: 'cap-2', createdBy: 'user-9' })];
		// Arm 1 (never stamped) answers with both rows; arm 2 (re-opened) with none,
		// which is the ordinary case — nothing in this group has been deleted.
		programSelects(captures, rows, []);

		// Every member sees EVERY member's open Captures — there is no author filter.
		const seen = await listOpenCaptures('user-42', 'group-1');
		expect(seen.map((c) => c.id).sort()).toEqual(['cap-1', 'cap-2']);
		// ONE QUERY PER ARM (issue #91) — see the arm tests below for why.
		expect(calls.log).toEqual(['select:members', 'select:captures', 'select:captures']);
	});

	it('merges the two arms newest-first, by real-world day', async () => {
		// The tray orders the concatenation itself now, so a re-opened note (arm 2)
		// lands where its own `captured_for` puts it — not above or below everything
		// that was never recorded.
		setAccess(true);
		const older = captureRow({ id: 'cap-old', capturedFor: '2026-09-01' });
		const newer = captureRow({ id: 'cap-new', capturedFor: '2026-09-09' });
		const reopened = captureRow({
			id: 'cap-reopened',
			capturedFor: '2026-09-05',
			resolvedTransactionId: 'txn-deleted',
			resolvedAt: new Date('2026-09-06T00:00:00Z')
		});
		programSelects(captures, [older, newer], [reopened]);

		const seen = await listOpenCaptures('user-42', 'group-1');

		expect(seen.map((c) => c.id)).toEqual(['cap-new', 'cap-reopened', 'cap-old']);
	});

	it('breaks a same-day tie on when the note was written, then on id', async () => {
		setAccess(true);
		const day = '2026-09-05';
		const early = captureRow({
			id: 'cap-a',
			capturedFor: day,
			createdAt: new Date('2026-09-05T08:00:00Z')
		});
		const late = captureRow({
			id: 'cap-b',
			capturedFor: day,
			createdAt: new Date('2026-09-05T20:00:00Z')
		});
		const sameMoment = captureRow({
			id: 'cap-c',
			capturedFor: day,
			createdAt: new Date('2026-09-05T20:00:00Z')
		});
		programSelects(captures, [early, late, sameMoment], []);

		const seen = await listOpenCaptures('user-42', 'group-1');

		// Newest written first; `id` DESC settles the exact-tie, so the order is stable
		// across reads instead of being left to the planner.
		expect(seen.map((c) => c.id)).toEqual(['cap-c', 'cap-b', 'cap-a']);
	});

	it('refuses a non-member and never touches the table (§12)', async () => {
		setAccess(false);

		await expect(listOpenCaptures('user-42', 'group-1')).rejects.toBeInstanceOf(GroupAccessError);
		expect(calls.log).toEqual(['select:members']);
	});
});

describe('resolveCapture', () => {
	const RESOLVE = { ...ARGS, captureId: 'cap-1', transactionId: 'txn-1' };

	it('verifies the transaction, stamps the row, then writes the audit entry', async () => {
		setAccess(true);
		programSelects(transactions, [{ id: 'txn-1' }]);
		state.updateReturning = [
			captureRow({ resolvedTransactionId: 'txn-1', resolvedAt: new Date('2026-09-07T00:00:00Z') })
		];

		const row = await resolveCapture(RESOLVE);

		expect(row.resolvedTransactionId).toBe('txn-1');
		expect(calls.log).toEqual([
			'select:members',
			'select:transactions',
			'update:captures',
			'insert:audit_log'
		]);
		// The row is STAMPED, never deleted — the trail from remembering to recording
		// has to survive.
		expect(Object.keys(calls.updates[0].set).sort()).toEqual([
			'resolvedAt',
			'resolvedTransactionId'
		]);
		// The conditional UPDATE carries the WHOLE open definition, not just the two
		// nulls: a re-opened note (recorded, then its transaction soft-deleted) is open,
		// so the tray's "Record it" has to work on it — offering an action on a row
		// nothing can act on would be worse than not showing it (issue #91).
		expect(updateWhere(0)).toContain('"transactions"."deleted_at" is not null');
		expect(updateWhere(0)).toContain('"captures"."resolved_at" is null');
		expect(auditInserts()[0].values).toMatchObject({
			action: 'resolve',
			entityType: 'capture',
			entityId: 'cap-1',
			summary: "Recorded 'dinner at the night market' from not recorded yet",
			metadata: { transactionId: 'txn-1' }
		});
	});

	it("refuses a transaction that is not this group's live transaction", async () => {
		setAccess(true);
		programSelects(transactions, []); // another group's id, a bogus id, or soft-deleted

		await expect(resolveCapture(RESOLVE)).rejects.toBeInstanceOf(TransactionNotFoundError);
		expect(calls.updates).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it('reports an ALREADY-RECORDED capture as a conflict, not a success', async () => {
		setAccess(true);
		programSelects(transactions, [{ id: 'txn-1' }]);
		state.updateReturning = []; // the conditional UPDATE matched nothing
		programSelects(captures, [{ resolvedAt: new Date('2026-09-06T00:00:00Z'), discardedAt: null }]);

		const error = await resolveCapture(RESOLVE).catch((e) => e);

		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('resolved');
		// Nothing was recorded twice, and no audit row claims it was.
		expect(auditInserts()).toHaveLength(0);
	});

	it('reports a DISCARDED capture as a conflict naming that ending', async () => {
		setAccess(true);
		programSelects(transactions, [{ id: 'txn-1' }]);
		state.updateReturning = [];
		programSelects(captures, [{ resolvedAt: null, discardedAt: new Date('2026-09-06T00:00:00Z') }]);

		const error = await resolveCapture(RESOLVE).catch((e) => e);

		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('discarded');
	});

	it('names the DISCARD when a row carries both stamps (issue #91)', async () => {
		// A re-opened note that was then given up on keeps its resolve stamp — the two
		// timestamps stopped being mutually exclusive the moment a discard could follow
		// a resolve. `discarded_at` is the terminal fact and must be read FIRST; the
		// other order tells the next person "someone already recorded this" about a
		// note nobody recorded.
		setAccess(true);
		programSelects(transactions, [{ id: 'txn-1' }]);
		state.updateReturning = [];
		programSelects(captures, [
			{
				resolvedAt: new Date('2026-09-06T00:00:00Z'),
				discardedAt: new Date('2026-09-07T00:00:00Z')
			}
		]);

		const error = await resolveCapture(RESOLVE).catch((e) => e);

		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('discarded');
		expect((error as CaptureNotOpenError).message).toBe('This has already been discarded');
	});

	it("reports another group's capture as NOT FOUND (§12 don't leak)", async () => {
		setAccess(true);
		programSelects(transactions, [{ id: 'txn-1' }]);
		state.updateReturning = [];
		programSelects(captures, []);

		await expect(resolveCapture(RESOLVE)).rejects.toBeInstanceOf(CaptureNotFoundError);
		expect(auditInserts()).toHaveLength(0);
	});

	it('refuses a non-member before touching anything (§12)', async () => {
		setAccess(false);

		await expect(resolveCapture(RESOLVE)).rejects.toBeInstanceOf(GroupAccessError);
		expect(calls.log).toEqual(['select:members']);
	});
});

describe('discardCapture', () => {
	const DISCARD = { ...ARGS, captureId: 'cap-1' };

	it('stamps `discarded_at` — a SOFT discard — and audits it', async () => {
		setAccess(true);
		state.updateReturning = [captureRow({ discardedAt: new Date('2026-09-07T00:00:00Z') })];

		const row = await discardCapture(DISCARD);

		expect(row.discardedAt).toBeInstanceOf(Date);
		expect(calls.log).toEqual(['select:members', 'update:captures', 'insert:audit_log']);
		// A soft stamp, never a delete: "we decided this wasn't worth recording" is
		// itself part of the trail.
		expect(Object.keys(calls.updates[0].set)).toEqual(['discardedAt']);
		// The same whole open definition as the resolve: a re-opened note can be given
		// up on too, and a discard is the ending that wins — restoring the transaction
		// afterwards must not resurrect it (issue #91).
		expect(updateWhere(0)).toContain('"transactions"."deleted_at" is not null');
		expect(auditInserts()[0].values).toMatchObject({
			action: 'discard',
			entityType: 'capture',
			entityId: 'cap-1',
			summary: "Discarded 'dinner at the night market' from not recorded yet"
		});
	});

	it('reports an already-closed capture as a conflict, writing no audit row', async () => {
		setAccess(true);
		state.updateReturning = [];
		programSelects(captures, [{ resolvedAt: new Date('2026-09-06T00:00:00Z'), discardedAt: null }]);

		const error = await discardCapture(DISCARD).catch((e) => e);

		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('resolved');
		expect(auditInserts()).toHaveLength(0);
	});

	it('refuses a non-member before touching anything (§12)', async () => {
		setAccess(false);

		await expect(discardCapture(DISCARD)).rejects.toBeInstanceOf(GroupAccessError);
		expect(calls.updates).toHaveLength(0);
	});
});

describe('the audit summaries never say the internal word (CONTEXT.md)', () => {
	it('phrases all three mutations as "not recorded yet"', async () => {
		const summaries: string[] = [];

		setAccess(true);
		state.insertReturning = [captureRow()];
		await createCapture({ ...ARGS, input: { note: 'dinner' } });
		summaries.push(auditInserts()[0].values.summary as string);

		calls.inserts.length = 0;
		setAccess(true);
		programSelects(transactions, [{ id: 'txn-1' }]);
		state.updateReturning = [captureRow()];
		await resolveCapture({ ...ARGS, captureId: 'cap-1', transactionId: 'txn-1' });
		summaries.push(auditInserts()[0].values.summary as string);

		calls.inserts.length = 0;
		setAccess(true);
		state.updateReturning = [captureRow()];
		await discardCapture({ ...ARGS, captureId: 'cap-1' });
		summaries.push(auditInserts()[0].values.summary as string);

		expect(summaries).toHaveLength(3);
		for (const summary of summaries) {
			// "Capture" is internal vocabulary; the feed renders these lines verbatim.
			expect(summary.toLowerCase()).not.toContain('capture');
			expect(summary).toContain('not recorded yet');
		}
	});
});

// ── The unrecorded COUNT (issue #50; PLAN §7.7 "Recall (no push)") ───────────
//
// Push notifications are out of scope (§1), so the count on `/groups` and the one
// on the group overview are the ENTIRE recall mechanism. Two things about it have
// to hold, and neither is provable by reading the call site:
//
//   1. it counts ONLY OPEN rows — a discarded Capture must not keep being counted
//      forever, which is what `resolved_at IS NULL` on its own would do;
//   2. the tray and the count use the SAME definition of open, or the badge says
//      "3" over a list of two.
//
// Both are pinned by compiling the shared predicate to SQL, which is the one thing
// a fluent stub genuinely cannot fake.

describe('countOpenCapturesByGroup', () => {
	it('counts per group in ONE query PER ARM, keyed by group id', async () => {
		programSelects(
			captures,
			[
				{ groupId: 'group-1', open: 3 },
				{ groupId: 'group-2', open: 1 }
			],
			// Arm 2: `group-1` also has a note whose transaction was soft-deleted, so the
			// two arms are SUMMED. They are disjoint, so nothing is counted twice.
			[{ groupId: 'group-1', open: 1 }]
		);

		const counts = await countOpenCapturesByGroup({
			userId: 'user-42',
			groupIds: ['group-1', 'group-2', 'group-3']
		});

		expect(counts.get('group-1')).toBe(4);
		expect(counts.get('group-2')).toBe(1);
		// A group with nothing open contributes no row — the callers read `?? 0`, so
		// absent and zero are the same to them and nothing leaks about what exists.
		expect(counts.has('group-3')).toBe(false);
		// TWO queries for a whole dashboard (one per arm), not one per card.
		expect(calls.log).toEqual(['select:captures', 'select:captures']);
	});

	it('issues NO query at all for an empty group list', async () => {
		const counts = await countOpenCapturesByGroup({ userId: 'user-42', groupIds: [] });

		expect(counts.size).toBe(0);
		expect(calls.log).toEqual([]);
	});

	it('counts ONLY OPEN rows — the WHOLE two-arm definition, compiled', () => {
		// The predicate is pinned WHOLE, not by fragments: this is the one thing a
		// fluent stub cannot fake, and a predicate that quietly loses an arm is exactly
		// the drift that puts a note in neither the ledger nor the queue.
		const { sql } = new PgDialect().sqlToQuery(openCapturePredicate()!);

		expect(sql).toBe(
			'(("captures"."resolved_at" is null and "captures"."discarded_at" is null) or ' +
				'("captures"."discarded_at" is null and exists (select 1 from "transactions" where ' +
				'("transactions"."id" = "captures"."resolved_transaction_id" and ' +
				'"transactions"."deleted_at" is not null))))'
		);
	});

	it('keeps arm 1 EXACTLY the partial index’s predicate', () => {
		// `captures_group_id_open_idx` is `resolved_at IS NULL AND discarded_at IS NULL`.
		// The tray and the count run this arm as its own query so Postgres can use that
		// index; the day the arm stops matching it, the index silently stops applying and
		// every page load reads the group's whole recorded history instead.
		const { sql } = new PgDialect().sqlToQuery(openCapturePredicate()!);

		expect(sql).toContain(
			'("captures"."resolved_at" is null and "captures"."discarded_at" is null)'
		);
		// Both nulls: a discarded Capture was never resolved, so `resolved_at IS NULL`
		// alone would keep counting it forever.
		expect(sql).toContain('"discarded_at" is null');
	});

	it('re-opens a note whose transaction is SOFT-deleted, and only that (issue #91)', () => {
		const { sql } = new PgDialect().sqlToQuery(openCapturePredicate()!);

		// Arm 2 asks the LINKED transaction whether it is soft-deleted...
		expect(sql).toContain('"transactions"."id" = "captures"."resolved_transaction_id"');
		expect(sql).toContain('"transactions"."deleted_at" is not null');
		// ...and NOT whether the link is missing. A hard delete fires the FK's `set
		// null`, and a dangling link must stay CLOSED (see `captures-schema.ts`); testing
		// `resolved_transaction_id IS NULL` would resurrect those rows instead.
		expect(sql).not.toContain('"resolved_transaction_id" is null');
		// The stamp is never read as cleared: openness is decided by the OTHER table.
		expect(sql).not.toContain('"resolved_at" is not null');
	});

	it('runs ONE ARM PER QUERY, each narrowed so its index applies', async () => {
		// The arms are OR-able (`openCapturePredicate` does exactly that for a by-id
		// read), but an OR'd query can use NEITHER partial index — Postgres would read
		// every note the group has ever recorded on every page load. So the two recall
		// surfaces issue one query per arm, and arm 2 carries the redundant
		// `transactions.group_id` qual that lets the planner drive from the small
		// soft-deleted set instead.
		programSelects(captures, [], []);

		await countOpenCapturesByGroup({ userId: 'user-42', groupIds: ['group-1'] });

		const wheres = calls.selectWheres.map(
			(w) => new PgDialect().sqlToQuery(w as Parameters<PgDialect['sqlToQuery']>[0]).sql
		);
		expect(wheres).toHaveLength(2);
		// Arm 1: the partial index's own predicate, with no `or` to defeat it.
		expect(wheres[0]).toContain('"captures"."resolved_at" is null');
		expect(wheres[0]).not.toContain(' or ');
		expect(wheres[0]).not.toContain('exists');
		// Arm 2: the join, narrowed on the transaction side, and no `or` either.
		expect(wheres[1]).toContain('"transactions"."deleted_at" is not null');
		expect(wheres[1]).toContain('"transactions"."group_id" in ');
		expect(wheres[1]).not.toContain(' or ');
	});

	it('narrows the tray’s second arm to the ONE group it is reading', async () => {
		setAccess(true);
		programSelects(captures, [], []);

		await listOpenCaptures('user-42', 'group-1');

		// The membership check (§12) is the first WHERE; the two arms follow it.
		const wheres = calls.selectWheres.map(
			(w) => new PgDialect().sqlToQuery(w as Parameters<PgDialect['sqlToQuery']>[0]).sql
		);
		expect(wheres).toHaveLength(3);
		expect(wheres[1]).toContain('"captures"."resolved_at" is null');
		expect(wheres[1]).not.toContain(' or ');
		expect(wheres[2]).toContain('"transactions"."group_id" = ');
		expect(wheres[2]).toContain('"transactions"."deleted_at" is not null');
		expect(wheres[2]).not.toContain(' or ');
	});

	it('gates on the FULL access check — an active member AND a live group (§12)', async () => {
		// The join is the BATCHED form of `userHasGroupAccess`, and it has to be the
		// whole of it. Dropping `groups.deleted_at IS NULL` would leave a soft-deleted
		// group's open notes counted — two access predicates differing silently, which is
		// how one of them quietly stops meaning what its docstring says.
		programSelects(captures, []);

		await countOpenCapturesByGroup({ userId: 'user-42', groupIds: ['group-1'] });

		const joined = calls.joins.map((j) => ({
			table: j.table,
			sql: new PgDialect().sqlToQuery(j.on as Parameters<PgDialect['sqlToQuery']>[0]).sql
		}));
		const memberJoin = joined.find((j) => j.table === members);
		const groupJoin = joined.find((j) => j.table === groups);

		expect(memberJoin?.sql).toContain('"deactivated_at" is null');
		expect(groupJoin?.sql).toContain('"deleted_at" is null');
	});

	it('shares that definition with the tray, rather than agreeing by inspection', () => {
		// `listOpenCaptures` and `countOpenCapturesByGroup` both call this one
		// function; a badge that disagrees with the list under it is the failure this
		// prevents. (The predicate also matches `captures_group_id_open_idx`.)
		const first = new PgDialect().sqlToQuery(openCapturePredicate()!).sql;
		const second = new PgDialect().sqlToQuery(openCapturePredicate()!).sql;
		expect(first).toBe(second);
	});
});

describe('findOpenCapture', () => {
	const FIND = { ...ARGS, captureId: 'cap-1' };

	it('returns the row the prefill will seed the form from', async () => {
		setAccess(true);
		programSelects(captures, [captureRow({ amountMinor: 120000, currency: 'THB' })]);

		const row = await findOpenCapture(FIND);

		expect(row?.note).toBe('dinner at the night market');
		expect(row?.amountMinor).toBe(120000);
		// Membership (§12) FIRST, then one read. Nothing is written by a prefill.
		expect(calls.log).toEqual(['select:members', 'select:captures']);
		expect(calls.updates).toHaveLength(0);
		expect(calls.inserts).toHaveLength(0);
	});

	it('returns null — never throws — for a row that is gone or already closed', async () => {
		setAccess(true);
		// The query carries the OPEN predicate, so a resolved, a discarded, another
		// group's and a nonexistent id all come back the same way. (That the predicate
		// really is in the WHERE is proved against a real database in
		// `tests/integration/capture-service.test.ts`.)
		programSelects(captures, []);

		await expect(findOpenCapture(FIND)).resolves.toBeNull();
	});

	it('refuses a non-member before reading anything (§12)', async () => {
		setAccess(false);

		await expect(findOpenCapture(FIND)).rejects.toBeInstanceOf(GroupAccessError);
		expect(calls.log).toEqual(['select:members']);
	});
});

describe('recordCaptureAsTransaction', () => {
	const RECORD = {
		...ARGS,
		captureId: 'cap-1',
		input: { title: 'Dinner', amountTotal: 120000 },
		settlementCurrency: 'THB' as const
	};

	/**
	 * Stand in for the ledger: run the caller's same-transaction hook with the stub
	 * executor (this is exactly what `createTransaction` does with its own `tx`) and
	 * hand back the new transaction id.
	 */
	function ledgerWrites(transactionId = 'txn-9') {
		createTransaction.mockImplementation(async ({ alsoWrite }) => {
			await alsoWrite?.(db, transactionId);
			return transactionId;
		});
	}

	it("stamps the Capture through the ledger write's OWN transaction handle", async () => {
		ledgerWrites();
		programSelects(transactions, [{ id: 'txn-9' }]);
		state.updateReturning = [captureRow({ resolvedTransactionId: 'txn-9' })];

		await expect(recordCaptureAsTransaction(RECORD)).resolves.toBe('txn-9');

		// The stamp + its audit row ran on the handle the create passed in — that is
		// what puts them in the SAME DB transaction as the insert (§12.1).
		expect(calls.log).toEqual(['select:transactions', 'update:captures', 'insert:audit_log']);
		expect(calls.updates[0].set).toMatchObject({ resolvedTransactionId: 'txn-9' });
		expect(auditInserts()[0].values).toMatchObject({
			action: 'resolve',
			entityType: 'capture',
			entityId: 'cap-1',
			metadata: { transactionId: 'txn-9' }
		});
		// Membership is NOT re-checked here: `createTransaction` gates the write, and a
		// second round-trip per save would buy nothing.
		expect(calls.log).not.toContain('select:members');
	});

	it('hands the ledger the prefilled input UNCHANGED, with no Capture fields added', async () => {
		ledgerWrites();
		programSelects(transactions, [{ id: 'txn-9' }]);
		state.updateReturning = [captureRow()];

		await recordCaptureAsTransaction(RECORD);

		const arg = createTransaction.mock.calls[0][0];
		// The prefill is a starting point, not a trusted payload: it goes through the
		// ordinary create, which re-validates all of §7.4. Nothing about the Capture
		// travels into the ledger row.
		expect(arg.input).toBe(RECORD.input);
		expect(arg.userId).toBe('user-42');
		expect(arg.groupId).toBe('group-1');
		expect(arg.settlementCurrency).toBe('THB');
		expect(arg).not.toHaveProperty('captureId');
	});

	it('fails the WHOLE write when someone else already recorded that note', async () => {
		ledgerWrites();
		programSelects(transactions, [{ id: 'txn-9' }]);
		state.updateReturning = []; // the conditional UPDATE matched nothing
		programSelects(captures, [{ resolvedAt: new Date('2026-09-06T00:00:00Z'), discardedAt: null }]);

		const error = await recordCaptureAsTransaction(RECORD).catch((e) => e);

		// Thrown from INSIDE the create's transaction, so the half-written transaction
		// goes down with it: the loser of a double-submit records nothing at all.
		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('resolved');
		expect(auditInserts()).toHaveLength(0);
	});

	it('fails the whole write for a discarded note, naming that ending', async () => {
		ledgerWrites();
		programSelects(transactions, [{ id: 'txn-9' }]);
		state.updateReturning = [];
		programSelects(captures, [{ resolvedAt: null, discardedAt: new Date('2026-09-06T00:00:00Z') }]);

		const error = await recordCaptureAsTransaction(RECORD).catch((e) => e);

		expect(error).toBeInstanceOf(CaptureNotOpenError);
		expect((error as CaptureNotOpenError).reason).toBe('discarded');
	});

	it("fails the whole write for a note that is not this group's", async () => {
		ledgerWrites();
		programSelects(transactions, [{ id: 'txn-9' }]);
		state.updateReturning = [];
		programSelects(captures, []);

		await expect(recordCaptureAsTransaction(RECORD)).rejects.toBeInstanceOf(CaptureNotFoundError);
		expect(auditInserts()).toHaveLength(0);
	});

	it('never lets a ledger failure leave a Capture stamped', async () => {
		// The create itself refuses the payload (§7.4). The hook never runs, so the
		// Capture stays OPEN and in everyone's tray — where it belongs, since nothing
		// was recorded.
		createTransaction.mockRejectedValueOnce(new Error('validation'));

		await expect(recordCaptureAsTransaction(RECORD)).rejects.toThrow('validation');
		expect(calls.updates).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});
});
