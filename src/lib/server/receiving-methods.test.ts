import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// Unit spec for the receiving-method service (issue #84; PLAN §17.1, §17.5;
// ADR-0016).
//
// STRATEGY (mirrors `members.test.ts`): NO real DB. `$lib/server/db` is a small
// fluent query-builder stub, so what is asserted here is what a stub CAN honestly
// prove — the decisions the service makes before and around the SQL:
//   - the registry gate runs BEFORE any write, and the PARSED details are what get
//     stored (trimmed, unknown keys stripped);
//   - `update` re-validates against the STORED rail, never a submitted one;
//   - a missing row (which is also another user's row) → `ReceivingMethodNotFound`;
//   - `reorder` writes positions by index, and writes NOTHING at all when the id
//     set doesn't match;
//   - NO MUTATION WRITES AN audit_log ROW (ADR-0016).
//
// The VISIBILITY rule (`listForViewer`) is deliberately NOT unit-tested: its whole
// content is a SQL predicate over `members`/`groups`, and a stub that returns
// whatever it was programmed to return would assert nothing. It is pinned against
// a real database in `tests/integration/receiving-method-service.test.ts`, which
// also proves the reorder transaction and the empty audit table.

// --- Fluent DB mock -------------------------------------------------------
const {
	selectQueue,
	selectCalls,
	insertCalls,
	updateCalls,
	updateReturns,
	deleteCalls,
	deleteReturns,
	makeDb
} = vi.hoisted(() => {
	// Row-sets the successive SELECT chains resolve to, in call order.
	const selectQueue: unknown[][] = [];
	const selectCalls: { n: number } = { n: 0 };
	const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
	const updateCalls: { set: Record<string, unknown> }[] = [];
	const deleteCalls: { table: unknown }[] = [];
	// What `... RETURNING` resolves to on the next write (empty = no such row).
	const updateReturns: { rows: unknown[] } = { rows: [] };
	const deleteReturns: { rows: unknown[] } = { rows: [] };

	function selectChain() {
		selectCalls.n += 1;
		const rows = selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
		const chain: Record<string, unknown> = {};
		// `for` backs `.for('update')` — `reorder` locks the profile before it
		// compares id sets, so the stub has to model that call.
		for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'for']) {
			chain[m] = () => chain;
		}
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	function insertChain(table: unknown) {
		return {
			values(values: Record<string, unknown>) {
				insertCalls.push({ table, values });
				return {
					returning: () => Promise.resolve([{ id: 'rm-new', ...values }]),
					then: (resolve: (v: unknown) => unknown) => resolve(undefined)
				};
			}
		};
	}

	function updateChain() {
		const chain: Record<string, unknown> = {};
		chain.set = (v: Record<string, unknown>) => {
			updateCalls.push({ set: v });
			return chain;
		};
		chain.where = () => chain;
		chain.returning = () => Promise.resolve(updateReturns.rows);
		chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
		return chain;
	}

	function deleteChain(table: unknown) {
		deleteCalls.push({ table });
		const chain: Record<string, unknown> = {};
		chain.where = () => chain;
		chain.returning = () => Promise.resolve(deleteReturns.rows);
		chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
		return chain;
	}

	const executor = {
		select: () => selectChain(),
		insert: (table: unknown) => insertChain(table),
		update: () => updateChain(),
		delete: (table: unknown) => deleteChain(table)
	};

	const db = {
		...executor,
		transaction: (cb: (tx: typeof executor) => Promise<unknown>) => cb(executor)
	};

	return {
		selectQueue,
		selectCalls,
		insertCalls,
		updateCalls,
		updateReturns,
		deleteCalls,
		deleteReturns,
		makeDb: () => db
	};
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	listOwn,
	create,
	update,
	remove,
	reorder,
	InvalidReceivingMethodError,
	ReceivingMethodNotFoundError,
	ReceivingMethodOrderMismatchError
} from './receiving-methods';
import { receivingMethod } from './db/receiving-schema';
import { auditLog } from './db/audit-schema';

/** Queue the row-sets each successive SELECT resolves to, in order. */
function queueSelects(...rowSets: unknown[][]) {
	selectQueue.length = 0;
	selectQueue.push(...rowSets);
}

/** Every recorded write, whatever the table. */
function writeCount() {
	return insertCalls.length + updateCalls.length + deleteCalls.length;
}

const OWNER = 'user-1';

const BANK_DETAILS = {
	bank: 'kbank',
	accountNumber: '1234567890',
	accountHolderName: 'Somchai Jaidee'
};

const PROMPTPAY_DETAILS = {
	proxyType: 'mobile',
	proxyValue: '0812345678',
	accountHolderName: 'Somchai Jaidee'
};

/** A stored row as the scoped SELECT in `update` would return it. */
function storedRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'rm-1',
		userId: OWNER,
		rail: 'th_bank_account',
		details: BANK_DETAILS,
		position: 0,
		createdAt: new Date(),
		...overrides
	};
}

beforeEach(() => {
	selectQueue.length = 0;
	selectCalls.n = 0;
	insertCalls.length = 0;
	updateCalls.length = 0;
	deleteCalls.length = 0;
	updateReturns.rows = [storedRow()];
	deleteReturns.rows = [];
});

describe('listOwn', () => {
	it('returns the caller’s rows', async () => {
		const rows = [storedRow(), storedRow({ id: 'rm-2', position: 1 })];
		queueSelects(rows);
		expect(await listOwn(OWNER)).toEqual(rows);
	});

	it('reads only — no write of any kind', async () => {
		queueSelects([]);
		await listOwn(OWNER);
		expect(writeCount()).toBe(0);
	});
});

describe('create', () => {
	it('inserts the method for the calling user', async () => {
		const row = await create(OWNER, 'th_bank_account', BANK_DETAILS);

		expect(insertCalls).toHaveLength(1);
		expect(insertCalls[0].table).toBe(receivingMethod);
		expect(insertCalls[0].values.userId).toBe(OWNER);
		expect(insertCalls[0].values.rail).toBe('th_bank_account');
		expect(row.id).toBe('rm-new');
	});

	it('stores the PARSED details — trimmed, with unknown keys stripped', async () => {
		await create(OWNER, 'th_bank_account', {
			...BANK_DETAILS,
			accountHolderName: '  Somchai Jaidee  ',
			userId: 'someone-else',
			position: 99
		});

		expect(insertCalls[0].values.details).toEqual(BANK_DETAILS);
	});

	it('appends: position is computed by the database, not read then written', async () => {
		await create(OWNER, 'other', { label: 'Wise', text: 'IBAN DE89…' });

		// A `max(position) + 1` SUB-SELECT, so two concurrent adds can't both read
		// the same maximum. Asserted structurally: the value handed to the INSERT is
		// SQL rather than a number this process computed, and no SELECT ran first.
		expect(typeof insertCalls[0].values.position).not.toBe('number');
		expect(selectCalls.n).toBe(0);
	});

	it('rejects an unknown rail BEFORE touching the database', async () => {
		await expect(create(OWNER, 'sepa', BANK_DETAILS)).rejects.toBeInstanceOf(
			InvalidReceivingMethodError
		);
		expect(writeCount()).toBe(0);
	});

	it('reports an unknown rail as unknown_rail, with no schema issues to show', async () => {
		const error = await create(OWNER, 'sepa', BANK_DETAILS).catch((e) => e);
		expect(error.reason).toBe('unknown_rail');
		expect(error.error).toBeUndefined();
		expect(error.code).toBe('invalid_receiving_method');
	});

	it('rejects details the rail’s own schema refuses, and writes nothing', async () => {
		const error = await create(OWNER, 'th_bank_account', {
			...BANK_DETAILS,
			accountHolderName: '   '
		}).catch((e) => e);

		expect(error).toBeInstanceOf(InvalidReceivingMethodError);
		expect(error.reason).toBe('invalid_details');
		// The rail's OWN issues are carried through for the form to render.
		expect(error.error.issues.map((i: { path: unknown[] }) => i.path.join('.'))).toContain(
			'accountHolderName'
		);
		expect(writeCount()).toBe(0);
	});

	it('rejects details belonging to a DIFFERENT rail', async () => {
		await expect(create(OWNER, 'th_promptpay', BANK_DETAILS)).rejects.toBeInstanceOf(
			InvalidReceivingMethodError
		);
		expect(writeCount()).toBe(0);
	});
});

describe('update', () => {
	it('re-validates against the STORED rail, not a submitted one', async () => {
		// The row is a PromptPay method; bank-account details must not be accepted
		// just because they are valid for some other rail.
		queueSelects([storedRow({ rail: 'th_promptpay', details: PROMPTPAY_DETAILS })]);

		const error = await update(OWNER, 'rm-1', BANK_DETAILS).catch((e) => e);

		expect(error).toBeInstanceOf(InvalidReceivingMethodError);
		expect(error.reason).toBe('invalid_details');
		expect(writeCount()).toBe(0);
	});

	it('writes the parsed details when they match the stored rail', async () => {
		queueSelects([storedRow({ rail: 'th_promptpay', details: PROMPTPAY_DETAILS })]);

		await update(OWNER, 'rm-1', { ...PROMPTPAY_DETAILS, proxyValue: ' 0898765432 ' });

		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0].set).toEqual({
			details: { ...PROMPTPAY_DETAILS, proxyValue: '0898765432' }
		});
	});

	it('never rewrites the rail', async () => {
		queueSelects([storedRow()]);
		await update(OWNER, 'rm-1', BANK_DETAILS);
		expect(updateCalls[0].set).not.toHaveProperty('rail');
	});

	it('is NOT FOUND for another user’s row (never a 403)', async () => {
		// The scoped SELECT filters on `user_id`, so somebody else's row simply
		// isn't there — the caller cannot tell it exists.
		queueSelects([]);

		const error = await update('intruder', 'rm-1', BANK_DETAILS).catch((e) => e);

		expect(error).toBeInstanceOf(ReceivingMethodNotFoundError);
		expect(error.code).toBe('receiving_method_not_found');
		expect(writeCount()).toBe(0);
	});

	it('is NOT FOUND when the row disappears between the read and the write', async () => {
		queueSelects([storedRow()]);
		// The UPDATE ... RETURNING comes back empty — deleted by another tab after
		// the read. The ownership predicate is repeated on the UPDATE itself, so the
		// write is scoped even though a read already checked.
		updateReturns.rows = [];

		await expect(update(OWNER, 'rm-1', BANK_DETAILS)).rejects.toBeInstanceOf(
			ReceivingMethodNotFoundError
		);
	});
});

describe('remove', () => {
	it('hard-deletes the row and returns it', async () => {
		deleteReturns.rows = [storedRow()];

		const row = await remove(OWNER, 'rm-1');

		expect(deleteCalls).toHaveLength(1);
		expect(deleteCalls[0].table).toBe(receivingMethod);
		expect(row.id).toBe('rm-1');
		// A hard delete: nothing references a method (PLAN §17.5), so there is no
		// soft-delete flag to set — the row is gone, not marked.
		expect(updateCalls).toHaveLength(0);
	});

	it('is NOT FOUND for another user’s row (never a 403)', async () => {
		deleteReturns.rows = [];

		const error = await remove('intruder', 'rm-1').catch((e) => e);

		expect(error).toBeInstanceOf(ReceivingMethodNotFoundError);
		expect(error.code).toBe('receiving_method_not_found');
	});
});

describe('reorder', () => {
	it('rewrites every position by array index', async () => {
		queueSelects([{ id: 'a' }, { id: 'b' }, { id: 'c' }], []);

		await reorder(OWNER, ['c', 'a', 'b']);

		expect(updateCalls.map((c) => c.set)).toEqual([
			{ position: 0 },
			{ position: 1 },
			{ position: 2 }
		]);
	});

	it('rejects an id set that is MISSING one of the caller’s methods', async () => {
		queueSelects([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

		const error = await reorder(OWNER, ['c', 'a']).catch((e) => e);

		expect(error).toBeInstanceOf(ReceivingMethodOrderMismatchError);
		expect(error.code).toBe('receiving_method_order_mismatch');
		// Nothing written: a partially applied order silently promotes the wrong
		// account to "preferred", which is the one the settle screen shows.
		expect(writeCount()).toBe(0);
	});

	it('rejects an id set containing a method that is not the caller’s', async () => {
		// The current-id SELECT is scoped to the caller, so a foreign id is simply
		// "extra" — indistinguishable from an id that never existed.
		queueSelects([{ id: 'a' }, { id: 'b' }]);

		await expect(reorder(OWNER, ['a', 'b', 'someone-elses'])).rejects.toBeInstanceOf(
			ReceivingMethodOrderMismatchError
		);
		expect(writeCount()).toBe(0);
	});

	it('rejects duplicates, which would otherwise leave a row unmoved', async () => {
		queueSelects([{ id: 'a' }, { id: 'b' }]);

		await expect(reorder(OWNER, ['a', 'a'])).rejects.toBeInstanceOf(
			ReceivingMethodOrderMismatchError
		);
		expect(writeCount()).toBe(0);
	});

	it('accepts an empty order for an empty profile', async () => {
		queueSelects([], []);
		expect(await reorder(OWNER, [])).toEqual([]);
		expect(writeCount()).toBe(0);
	});
});

describe('audit_log (ADR-0016 — the deliberate exception)', () => {
	it('writes NO audit row for create / update / remove / reorder', async () => {
		queueSelects([storedRow()], [{ id: 'rm-1' }], []);

		await create(OWNER, 'th_bank_account', BANK_DETAILS);
		await update(OWNER, 'rm-1', BANK_DETAILS);
		deleteReturns.rows = [storedRow()];
		await remove(OWNER, 'rm-1');
		await reorder(OWNER, ['rm-1']);

		// All four mutations ran (so the assertion below isn't vacuous)…
		expect(writeCount()).toBeGreaterThanOrEqual(4);
		// …and not one of them touched `audit_log`.
		expect(insertCalls.filter((c) => c.table === auditLog)).toEqual([]);
		expect(deleteCalls.filter((c) => c.table === auditLog)).toEqual([]);
	});

	it('does not even import the audit writer', async () => {
		// A stronger guard than counting inserts: `audit_log` rows are GROUP-scoped
		// and readable by every member, and a receiving method belongs to a USER, so
		// there is no correct `group_id` to write and fanning one out would broadcast
		// "X changed their bank account" into every group they are in (ADR-0016).
		// If this fails, read the ADR before "fixing" it — the absence is the decision.
		const source = readFileSync(new URL('./receiving-methods.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/from '\.\/audit'/);
		expect(source).not.toMatch(/writeAuditLog/);
	});
});
