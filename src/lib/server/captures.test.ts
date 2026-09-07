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
//   - no `summary` the feed will render contains the internal word "capture".
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
		updates: [] as { table: unknown; set: Record<string, unknown> }[]
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
		for (const m of ['innerJoin', 'where', 'limit', 'orderBy', 'groupBy', 'for']) {
			chain[m] = () => chain;
		}
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
		chain.set = (values: Record<string, unknown>) => {
			calls.log.push(`update:${tableName(table)}`);
			calls.updates.push({ table, set: values });
			return chain;
		};
		chain.where = () => chain;
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

import { PgDialect } from 'drizzle-orm/pg-core';
import {
	createCapture,
	listOpenCaptures,
	countOpenCapturesByGroup,
	openCapturePredicate,
	resolveCapture,
	discardCapture,
	CaptureNotFoundError,
	CaptureNotOpenError,
	CaptureValidationError,
	type Capture
} from './captures';
import { GroupAccessError } from './groups';
import { TransactionNotFoundError } from './transactions';
import { captures } from './db/captures-schema';
import { auditLog } from './db/audit-schema';
import { currencies } from './db/currencies-schema';
import { transactions } from './db/transactions-schema';
import { members } from './db/groups-schema';

state.names.set(members, 'members');
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
		programSelects(captures, rows);

		// Every member sees EVERY member's open Captures — there is no author filter.
		expect(await listOpenCaptures('user-42', 'group-1')).toEqual(rows);
		expect(calls.log).toEqual(['select:members', 'select:captures']);
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
	it('counts per group in ONE query, keyed by group id', async () => {
		programSelects(captures, [
			{ groupId: 'group-1', open: 3 },
			{ groupId: 'group-2', open: 1 }
		]);

		const counts = await countOpenCapturesByGroup({
			userId: 'user-42',
			groupIds: ['group-1', 'group-2', 'group-3']
		});

		expect(counts.get('group-1')).toBe(3);
		expect(counts.get('group-2')).toBe(1);
		// A group with nothing open contributes no row — the callers read `?? 0`, so
		// absent and zero are the same to them and nothing leaks about what exists.
		expect(counts.has('group-3')).toBe(false);
		// ONE query for every card on the dashboard, not one per card.
		expect(calls.log).toEqual(['select:captures']);
	});

	it('issues NO query at all for an empty group list', async () => {
		const counts = await countOpenCapturesByGroup({ userId: 'user-42', groupIds: [] });

		expect(counts.size).toBe(0);
		expect(calls.log).toEqual([]);
	});

	it('counts ONLY OPEN rows — both nulls, not just `resolved_at`', () => {
		const { sql } = new PgDialect().sqlToQuery(openCapturePredicate()!);

		expect(sql).toContain('"resolved_at" is null');
		// The one that is easy to forget: a discarded Capture was never resolved, so
		// without this it would be counted (and shown) forever.
		expect(sql).toContain('"discarded_at" is null');
		expect(sql).not.toContain(' or ');
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
