import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the custom-currency service (issue #61; PLAN §7.5.2, §12, §12.1;
// ADR-0014).
//
// STRATEGY (mirrors `groups.test.ts`): there is NO real DB here — the real
// round-trips, the real `FOR UPDATE`/FK interaction and the real transactional
// rollback are proved in `tests/integration/custom-currency-service.test.ts`. What
// these tests pin down is the SERVICE LOGIC and its ORDER OF OPERATIONS:
//   - membership (§12) is asserted on all FOUR operations, before anything else;
//   - a rejected mutation records NO audit insert at all (the same-transaction
//     write can't have happened);
//   - the duplicate-display-code rule, and WHICH kind it clashed with;
//   - the IMMUTABILITY LOCK — refused only for the frozen fields that actually
//     move, only once referenced, and checked AFTER the row lock is taken and
//     INSIDE the same transaction as the write (asserted via the recorded call
//     order, which is the observable shape of the atomicity claim);
//   - the composition + ordering of `listCurrenciesForGroup`.
//
// The fluent stub records every insert/update/delete and lets a test program what
// each table's SELECT resolves to, as a QUEUE (the edit path selects `currencies`
// twice: the locked row load, then the duplicate check).

const { state, calls, makeDb } = vi.hoisted(() => {
	const state = {
		/** table object → queue of row-sets, shifted one per `select().from(table)`. */
		selects: new Map<unknown, unknown[][]>(),
		/** table object → label for the ordered call log (registered below the imports). */
		names: new Map<unknown, string>(),
		/** Thrown by the next `insert(...).values(...).returning()` when set. */
		insertError: null as unknown,
		/** Thrown by the next `update(...).returning()` when set. */
		updateError: null as unknown,
		/** Rows the next `update(...).returning()` resolves to. */
		updateReturning: [] as unknown[]
	};

	const calls = {
		/** Ordered log of DB operations, e.g. 'select:currencies(for update)'. */
		log: [] as string[],
		inserts: [] as { table: unknown; values: unknown }[],
		updates: [] as { table: unknown; set: unknown }[],
		deletes: [] as { table: unknown }[]
	};

	/** Table label for the ordered log (registered by identity below the imports). */
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
		let locked = false;
		for (const m of ['innerJoin', 'where', 'limit', 'orderBy', 'groupBy']) chain[m] = () => chain;
		chain.from = (t: unknown) => {
			table = t;
			return chain;
		};
		chain.for = (strength: string) => {
			locked = strength === 'update';
			return chain;
		};
		chain.then = (resolve: (v: unknown) => unknown) => {
			calls.log.push(`select:${tableName(table)}${locked ? '(for update)' : ''}`);
			return resolve(nextRows(table));
		};
		return chain;
	}

	function insertChain(table: unknown) {
		return {
			values(values: unknown) {
				calls.log.push(`insert:${tableName(table)}`);
				calls.inserts.push({ table, values });
				const settle = () => {
					if (state.insertError) {
						const e = state.insertError;
						state.insertError = null;
						return Promise.reject(e);
					}
					return Promise.resolve([values]);
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
		chain.set = (values: unknown) => {
			calls.log.push(`update:${tableName(table)}`);
			calls.updates.push({ table, set: values });
			return chain;
		};
		chain.where = () => chain;
		chain.returning = () => {
			if (state.updateError) {
				const e = state.updateError;
				state.updateError = null;
				return Promise.reject(e);
			}
			return Promise.resolve(state.updateReturning);
		};
		chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
		return chain;
	}

	function deleteChain(table: unknown) {
		const chain: Record<string, unknown> = {};
		chain.where = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => {
			calls.log.push(`delete:${tableName(table)}`);
			calls.deletes.push({ table });
			return resolve(undefined);
		};
		return chain;
	}

	const executor = {
		select: () => selectChain(),
		insert: (table: unknown) => insertChain(table),
		update: (table: unknown) => updateChain(table),
		delete: (table: unknown) => deleteChain(table)
	};

	const db = {
		...executor,
		transaction: (cb: (tx: typeof executor) => Promise<unknown>) => cb(executor)
	};

	return { state, calls, makeDb: () => db };
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	createCustomCurrency,
	updateCustomCurrency,
	deleteCustomCurrency,
	findReferencedCurrencyCodes,
	listCurrenciesForGroup,
	CurrencyImmutableError,
	CurrencyInUseError,
	CurrencyNotFoundError,
	DuplicateDisplayCodeError,
	type CurrencyRow
} from './currencies';
import { GroupAccessError } from './groups';
import { auditLog } from './db/audit-schema';
import { currencies } from './db/currencies-schema';
import { transactions } from './db/transactions-schema';
import { members } from './db/groups-schema';
import { CUSTOM_CURRENCY_CODE_PREFIX } from './db/currencies-schema';
import { CURRENCY_CODES } from '$lib/money';

// Label the tables by identity so the ordered call log is readable (and stable —
// no reliance on drizzle's internal name symbols).
state.names.set(members, 'members');
state.names.set(currencies, 'currencies');
state.names.set(transactions, 'transactions');
state.names.set(auditLog, 'audit_log');

/** Program the rows the Nth `select().from(table)` resolves to (in order). */
function programSelects(table: unknown, ...rowSets: unknown[][]) {
	state.selects.set(table, rowSets);
}

/** Grant / deny the §12 membership check (a member row = access). */
function setAccess(granted: boolean, times = 1) {
	programSelects(members, ...Array.from({ length: times }, () => (granted ? [{ id: 'm1' }] : [])));
}

/** The recorded audit_log inserts. */
function auditInserts() {
	return calls.inserts.filter((c) => c.table === auditLog);
}

/** A stored custom-currency row. */
function customRow(overrides: Partial<CurrencyRow> = {}): CurrencyRow {
	return {
		code: 'cur_11111111-1111-4111-8111-111111111111',
		displayCode: 'BEER',
		name: 'Bottle of beer',
		symbol: '🍺',
		exponent: 0,
		groupId: 'group-1',
		createdBy: 'user-42',
		createdAt: new Date('2026-08-01T00:00:00Z'),
		...overrides
	};
}

describe('findReferencedCurrencyCodes', () => {
	it('returns all referenced codes in one query', async () => {
		programSelects(transactions, [{ currency: 'cur_beer' }, { currency: 'cur_round' }]);

		const result = await findReferencedCurrencyCodes(['cur_beer', 'cur_round']);

		expect(result).toEqual(new Set(['cur_beer', 'cur_round']));
		expect(calls.log).toEqual(['select:transactions']);
	});

	it('skips the database for an empty code list', async () => {
		expect(await findReferencedCurrencyCodes([])).toEqual(new Set());
		expect(calls.log).toEqual([]);
	});
});

const VALID_INPUT = { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 0 };

beforeEach(() => {
	state.selects.clear();
	state.insertError = null;
	state.updateError = null;
	state.updateReturning = [];
	calls.log.length = 0;
	calls.inserts.length = 0;
	calls.updates.length = 0;
	calls.deletes.length = 0;
});

// ── §12 membership on ALL FOUR operations ─────────────────────────────────────

describe('membership enforcement (PLAN §12 — all four operations)', () => {
	it('createCustomCurrency throws GroupAccessError and writes nothing', async () => {
		setAccess(false);
		await expect(
			createCustomCurrency({ userId: 'u1', groupId: 'g1', input: VALID_INPUT })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(calls.inserts).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it('updateCustomCurrency throws GroupAccessError and writes nothing', async () => {
		setAccess(false);
		await expect(
			updateCustomCurrency({ userId: 'u1', groupId: 'g1', code: 'cur_x', input: { name: 'New' } })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(calls.updates).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it('deleteCustomCurrency throws GroupAccessError and writes nothing', async () => {
		setAccess(false);
		await expect(
			deleteCustomCurrency({ userId: 'u1', groupId: 'g1', code: 'cur_x' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(calls.deletes).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it('listCurrenciesForGroup throws GroupAccessError (the read is gated too)', async () => {
		setAccess(false);
		await expect(listCurrenciesForGroup({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('checks membership BEFORE reading or writing anything else', async () => {
		setAccess(false);
		await expect(
			deleteCustomCurrency({ userId: 'u1', groupId: 'g1', code: 'cur_x' })
		).rejects.toBeInstanceOf(GroupAccessError);
		// The members SELECT is the ONLY query that ran.
		expect(calls.log).toEqual(['select:members']);
	});
});

// ── createCustomCurrency ──────────────────────────────────────────────────────

describe('createCustomCurrency (PLAN §7.5.2)', () => {
	it('mints the opaque code itself and stores the server-derived fields', async () => {
		setAccess(true);
		programSelects(currencies, []); // no display-code clash

		const row = await createCustomCurrency({
			userId: 'user-42',
			groupId: 'group-1',
			input: VALID_INPUT
		});

		const inserted = calls.inserts.find((c) => c.table === currencies)!.values as Record<
			string,
			unknown
		>;
		// The PK is GENERATED here — never accepted from a caller (§7.5.2).
		expect(String(inserted.code).startsWith(CUSTOM_CURRENCY_CODE_PREFIX)).toBe(true);
		expect(inserted.code).not.toBe('BEER');
		expect(inserted).toMatchObject({
			displayCode: 'BEER',
			name: 'Bottle of beer',
			symbol: '🍺',
			exponent: 0,
			groupId: 'group-1',
			createdBy: 'user-42'
		});
		// No DB-level default for created_at — the service stamps it.
		expect(inserted.createdAt).toBeInstanceOf(Date);
		expect(row.displayCode).toBe('BEER');
	});

	it('normalizes the display code (trimmed + uppercased) before storing it', async () => {
		setAccess(true);
		programSelects(currencies, []);

		await createCustomCurrency({
			userId: 'u1',
			groupId: 'g1',
			input: { ...VALID_INPUT, displayCode: '  beer  ' }
		});

		const inserted = calls.inserts.find((c) => c.table === currencies)!.values as Record<
			string,
			unknown
		>;
		expect(inserted.displayCode).toBe('BEER');
	});

	it('writes exactly ONE audit row (create/currency) in the same transaction', async () => {
		setAccess(true);
		programSelects(currencies, []);

		await createCustomCurrency({ userId: 'user-42', groupId: 'group-1', input: VALID_INPUT });

		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const v = audits[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			groupId: 'group-1',
			actorUserId: 'user-42',
			action: 'create',
			entityType: 'currency'
		});
		// entityId is the OPAQUE code; the durable summary carries the display label.
		expect(String(v.entityId).startsWith(CUSTOM_CURRENCY_CODE_PREFIX)).toBe(true);
		expect(v.summary).toBe("Created custom currency 'BEER' (Bottle of beer)");
		expect(v.metadata).toMatchObject({ displayCode: 'BEER', exponent: 0 });
		// …and it is written AFTER the currency row, in the same unit of work.
		expect(calls.log).toEqual([
			'select:members',
			'select:currencies',
			'insert:currencies',
			'insert:audit_log'
		]);
	});

	it('rejects a display code that duplicates a SEEDED code, saying which', async () => {
		setAccess(true);
		programSelects(currencies, [{ code: 'USD', groupId: null }]);

		const err = await createCustomCurrency({
			userId: 'u1',
			groupId: 'g1',
			input: { ...VALID_INPUT, displayCode: 'USD' }
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(DuplicateDisplayCodeError);
		expect((err as DuplicateDisplayCodeError).conflictsWith).toBe('seeded');
		expect((err as Error).message).toContain('already a supported currency');
		// Nothing was written — not the currency, not the audit row.
		expect(calls.inserts).toHaveLength(0);
	});

	it('rejects a display code another CUSTOM row in the same group already has, saying which', async () => {
		setAccess(true);
		programSelects(currencies, [{ code: 'cur_other', groupId: 'g1' }]);

		const err = await createCustomCurrency({
			userId: 'u1',
			groupId: 'g1',
			input: VALID_INPUT
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(DuplicateDisplayCodeError);
		expect((err as DuplicateDisplayCodeError).conflictsWith).toBe('custom');
		expect((err as Error).message).toContain('This group already has a currency');
		expect(calls.inserts).toHaveLength(0);
	});

	it('maps a raced unique violation to the same duplicate error', async () => {
		setAccess(true);
		programSelects(currencies, []); // the pre-check sees nothing…
		// …but the `(group_id, display_code)` index is the final authority.
		state.insertError = Object.assign(new Error('duplicate key'), { code: '23505' });

		await expect(
			createCustomCurrency({ userId: 'u1', groupId: 'g1', input: VALID_INPUT })
		).rejects.toBeInstanceOf(DuplicateDisplayCodeError);
		expect(auditInserts()).toHaveLength(0);
	});

	it('rejects an invalid input before touching the database', async () => {
		setAccess(true);
		await expect(
			createCustomCurrency({ userId: 'u1', groupId: 'g1', input: { ...VALID_INPUT, exponent: 4 } })
		).rejects.toBeDefined();
		await expect(
			createCustomCurrency({
				userId: 'u1',
				groupId: 'g1',
				input: { ...VALID_INPUT, displayCode: ' ' }
			})
		).rejects.toBeDefined();
		expect(calls.log).toEqual([]);
	});
});

// ── updateCustomCurrency + THE IMMUTABILITY LOCK ──────────────────────────────

describe('updateCustomCurrency — the immutability lock (ADR-0014 decision 5)', () => {
	/** Program: access granted, the locked row load, then the reference check. */
	function programEdit({
		referenced,
		row = customRow()
	}: {
		referenced: boolean;
		row?: CurrencyRow;
	}) {
		setAccess(true);
		programSelects(currencies, [row], []); // row load, then (maybe) the dup check
		programSelects(transactions, referenced ? [{ id: 'txn-1' }] : []);
		state.updateReturning = [row];
	}

	it('accepts an exponent + displayCode edit BEFORE the first referencing transaction', async () => {
		const row = customRow();
		programEdit({ referenced: false, row });
		state.updateReturning = [{ ...row, displayCode: 'PINT', exponent: 2 }];

		const updated = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { displayCode: 'PINT', exponent: 2 }
		});

		expect(updated.displayCode).toBe('PINT');
		expect(calls.updates).toHaveLength(1);
		expect(calls.updates[0].set).toEqual({ displayCode: 'PINT', exponent: 2 });
	});

	it('an all-fields-IDENTICAL resubmission is a NO-OP — no UPDATE and no audit row', async () => {
		// Opening the edit form and pressing Save without touching anything. The shared
		// schema can't catch this (it only rejects an edit with no fields at all), so
		// the service compares against the loaded row and short-circuits — otherwise the
		// §12.1 feed grows a phantom "Edited" entry for a change nobody made.
		const row = customRow();
		programEdit({ referenced: false, row });

		const returned = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: {
				displayCode: row.displayCode,
				name: row.name,
				symbol: row.symbol,
				exponent: row.exponent
			}
		});

		// The caller still gets the current row back (a successful, idempotent save).
		expect(returned).toEqual(row);
		expect(calls.updates).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
		// It never even reached the reference read — nothing frozen was asked to move.
		expect(calls.log).toEqual(['select:members', 'select:currencies(for update)']);
	});

	it('is a NO-OP for an identical resubmission even once the row is REFERENCED', async () => {
		const row = customRow();
		programEdit({ referenced: true, row });

		const returned = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: {
				displayCode: row.displayCode,
				name: row.name,
				symbol: row.symbol,
				exponent: row.exponent
			}
		});

		// Resubmitting a frozen field unchanged is not an attempt to change it, so this
		// is a no-op rather than a `CurrencyImmutableError`.
		expect(returned).toEqual(row);
		expect(calls.updates).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it('REFUSES an exponent edit once a transaction references the row', async () => {
		const row = customRow();
		programEdit({ referenced: true, row });

		const err = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { exponent: 2 }
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(CurrencyImmutableError);
		expect((err as CurrencyImmutableError).fields).toEqual(['exponent']);
		expect((err as Error).message).toContain('BEER');
		// Nothing written — no update, no audit row.
		expect(calls.updates).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it('REFUSES a displayCode edit once referenced, and names BOTH frozen fields when both move', async () => {
		const row = customRow();
		programEdit({ referenced: true, row });

		const err = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { displayCode: 'PINT', exponent: 2 }
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(CurrencyImmutableError);
		expect((err as CurrencyImmutableError).fields).toEqual(['displayCode', 'exponent']);
		expect(calls.updates).toHaveLength(0);
	});

	it('still accepts a name/symbol edit AFTER the row is referenced', async () => {
		const row = customRow();
		programEdit({ referenced: true, row });
		state.updateReturning = [{ ...row, name: 'Pint of beer', symbol: '🍻' }];

		const updated = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { name: 'Pint of beer', symbol: '🍻' }
		});

		expect(updated.name).toBe('Pint of beer');
		expect(calls.updates[0].set).toEqual({ name: 'Pint of beer', symbol: '🍻' });
		expect(auditInserts()).toHaveLength(1);
	});

	it('treats a RESUBMITTED unchanged frozen field as no change (a full form still saves)', async () => {
		const row = customRow();
		programEdit({ referenced: true, row });
		state.updateReturning = [{ ...row, name: 'Pint of beer' }];

		const updated = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			// The whole form comes back, frozen fields included but IDENTICAL.
			input: { displayCode: 'BEER', name: 'Pint of beer', symbol: '🍺', exponent: 0 }
		});

		expect(updated.name).toBe('Pint of beer');
		const audit = auditInserts()[0].values as Record<string, unknown>;
		expect(audit.summary).toBe("Edited custom currency 'BEER' — changed name");
	});

	it('takes the row lock FIRST and checks the reference INSIDE the writing transaction', async () => {
		const row = customRow();
		programEdit({ referenced: false, row });
		state.updateReturning = [{ ...row, exponent: 2 }];

		await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { exponent: 2 }
		});

		// The order IS the atomicity claim: membership → SELECT … FOR UPDATE on the
		// currency row (which conflicts with the FK's key-share lock taken by a
		// concurrent transaction insert) → the reference read → the write → the audit
		// row. A reference check taken before the lock would let a concurrent first
		// transaction slip through.
		expect(calls.log).toEqual([
			'select:members',
			'select:currencies(for update)',
			'select:transactions',
			'update:currencies',
			'insert:audit_log'
		]);
	});

	it('rejects a display code that clashes with a seeded row', async () => {
		setAccess(true);
		const row = customRow();
		programSelects(currencies, [row], [{ code: 'USD', groupId: null }]);
		programSelects(transactions, []);

		const err = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { displayCode: 'USD' }
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(DuplicateDisplayCodeError);
		expect((err as DuplicateDisplayCodeError).conflictsWith).toBe('seeded');
		expect(calls.updates).toHaveLength(0);
	});

	it("does not treat the row's OWN display code as a duplicate", async () => {
		const row = customRow();
		setAccess(true);
		// The dup check finds the row itself — excluded by `excludeCode`.
		programSelects(currencies, [row], [{ code: row.code, groupId: 'group-1' }]);
		programSelects(transactions, []);
		state.updateReturning = [{ ...row, name: 'Renamed' }];

		const updated = await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { displayCode: 'BEER', name: 'Renamed' }
		});
		expect(updated.name).toBe('Renamed');
	});

	it("throws CurrencyNotFoundError for a code that is not this group's custom row", async () => {
		setAccess(true);
		programSelects(currencies, []); // scoped load found nothing (other group / seeded)

		await expect(
			updateCustomCurrency({ userId: 'u1', groupId: 'g1', code: 'USD', input: { name: 'X' } })
		).rejects.toBeInstanceOf(CurrencyNotFoundError);
		expect(calls.updates).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it('records a before/after snapshot in the audit metadata', async () => {
		const row = customRow();
		programEdit({ referenced: false, row });
		state.updateReturning = [{ ...row, exponent: 2, symbol: '🍻' }];

		await updateCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code,
			input: { exponent: 2, symbol: '🍻' }
		});

		const v = auditInserts()[0].values as Record<string, unknown>;
		expect(v).toMatchObject({ action: 'edit', entityType: 'currency', entityId: row.code });
		expect(v.metadata).toMatchObject({
			changed: ['symbol', 'exponent'],
			before: { exponent: 0, symbol: '🍺' },
			after: { exponent: 2, symbol: '🍻' }
		});
	});

	it('rejects an empty edit (nothing would have changed, but the trail would claim one)', async () => {
		setAccess(true);
		await expect(
			updateCustomCurrency({ userId: 'u1', groupId: 'g1', code: 'cur_x', input: {} })
		).rejects.toBeDefined();
		expect(calls.log).toEqual([]);
	});
});

// ── deleteCustomCurrency ──────────────────────────────────────────────────────

describe('deleteCustomCurrency (permitted only while unreferenced — PLAN §7.5.2)', () => {
	it('deletes an unreferenced row and writes one delete/currency audit entry', async () => {
		const row = customRow();
		setAccess(true);
		programSelects(currencies, [row]);
		programSelects(transactions, []);

		await deleteCustomCurrency({ userId: 'u1', groupId: 'group-1', code: row.code });

		expect(calls.deletes).toHaveLength(1);
		expect(calls.deletes[0].table).toBe(currencies);
		const v = auditInserts()[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			groupId: 'group-1',
			actorUserId: 'u1',
			action: 'delete',
			entityType: 'currency',
			entityId: row.code
		});
		// The row is gone, so the label MUST live in the summary (§12.1 denormalize).
		expect(v.summary).toBe("Deleted custom currency 'BEER' (Bottle of beer)");
		// Locked before the reference read, deleted and audited in the same tx.
		expect(calls.log).toEqual([
			'select:members',
			'select:currencies(for update)',
			'select:transactions',
			'delete:currencies',
			'insert:audit_log'
		]);
	});

	it('REFUSES to delete once a transaction references it', async () => {
		const row = customRow();
		setAccess(true);
		programSelects(currencies, [row]);
		programSelects(transactions, [{ id: 'txn-1' }]);

		const err = await deleteCustomCurrency({
			userId: 'u1',
			groupId: 'group-1',
			code: row.code
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(CurrencyInUseError);
		expect((err as Error).message).toContain('BEER');
		expect(calls.deletes).toHaveLength(0);
		expect(auditInserts()).toHaveLength(0);
	});

	it("throws CurrencyNotFoundError for a seeded code / another group's row", async () => {
		setAccess(true);
		programSelects(currencies, []);
		await expect(
			deleteCustomCurrency({ userId: 'u1', groupId: 'g1', code: 'USD' })
		).rejects.toBeInstanceOf(CurrencyNotFoundError);
		expect(calls.deletes).toHaveLength(0);
	});
});

// ── listCurrenciesForGroup ────────────────────────────────────────────────────

describe('listCurrenciesForGroup (the set the picker and the validator both read)', () => {
	it("returns seeded rows first in PLAN §7.5.1 order, then the group's custom rows by code", async () => {
		setAccess(true);
		// Deliberately shuffled, as a real unordered SELECT could return them.
		programSelects(currencies, [
			{
				code: 'cur_2',
				displayCode: 'ROUNDS',
				name: 'Round',
				symbol: 'R',
				exponent: 0,
				groupId: 'g1'
			},
			{
				code: 'USD',
				displayCode: 'USD',
				name: 'US Dollar',
				symbol: '$',
				exponent: 2,
				groupId: null
			},
			{
				code: 'cur_1',
				displayCode: 'BEER',
				name: 'Beer',
				symbol: '🍺',
				exponent: 0,
				groupId: 'g1'
			},
			{
				code: 'CNY',
				displayCode: 'CNY',
				name: 'Chinese Yuan',
				symbol: 'CN¥',
				exponent: 2,
				groupId: null
			}
		]);

		const list = await listCurrenciesForGroup({ userId: 'u1', groupId: 'g1' });

		expect(list.map((c) => c.displayCode)).toEqual(['CNY', 'USD', 'BEER', 'ROUNDS']);
		// CNY before USD because that is the canonical §7.5.1 rank order.
		expect(CURRENCY_CODES.indexOf('CNY')).toBeLessThan(CURRENCY_CODES.indexOf('USD'));
	});

	it('flags custom rows via the code != displayCode invariant (never via group_id)', async () => {
		setAccess(true);
		programSelects(currencies, [
			{
				code: 'THB',
				displayCode: 'THB',
				name: 'Thai Baht',
				symbol: '฿',
				exponent: 2,
				groupId: null
			},
			{ code: 'cur_1', displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0, groupId: 'g1' }
		]);

		const list = await listCurrenciesForGroup({ userId: 'u1', groupId: 'g1' });
		expect(list.map((c) => c.isCustom)).toEqual([false, true]);
	});

	it('is a pure read — no audit row', async () => {
		setAccess(true);
		programSelects(currencies, []);
		await listCurrenciesForGroup({ userId: 'u1', groupId: 'g1' });
		expect(auditInserts()).toHaveLength(0);
	});
});
