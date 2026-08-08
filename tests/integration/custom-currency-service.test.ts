// Real-DB integration tests — the CUSTOM-CURRENCY SERVICE (issue #61; PLAN
// §7.5.2, §12, §12.1; ADR-0014).
//
// The sibling suite `custom-currency-schema.test.ts` proves the TABLE's guarantees
// (backfill, unique index, cascades, the FK). This one drives the SERVICE
// (`src/lib/server/currencies.ts`) against the same running Postgres, because every
// claim it makes is a claim about a real transaction:
//
//   1. AUDIT ATOMICITY (§12.1). A create that fails inside the transaction leaves
//      NEITHER a `currencies` row NOR an `audit_log` row. A stubbed store cannot
//      show this — only a real rollback can.
//   2. THE IMMUTABILITY LOCK (ADR-0014 decision 5). `exponent` / `displayCode` move
//      freely until the FIRST transaction references the row, and are refused
//      afterwards; `name` / `symbol` stay editable either side of that line. The
//      "is it referenced?" question is answered by a real
//      `transactions.currency → currencies.code` row.
//   3. GROUP SCOPING. The same display code in two groups is fine; twice in one
//      group is not. `listCurrenciesForGroup` returns the 29 seeded rows plus THIS
//      group's custom rows and nobody else's.
//   4. MEMBERSHIP (§12) on all four operations, against real member rows.
//
// Cleanup mirrors the schema suite: `transactions.currency → currencies.code` is
// RESTRICT, so this suite's ledger rows go before its custom currencies; the custom
// rows are then deleted explicitly (they would cascade with the group, but
// `created_by` is `set null`, so a row that outlived its group would otherwise
// pollute the seeded table).

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createGroup, GroupAccessError } from '$lib/server/groups';
import {
	createCustomCurrency,
	updateCustomCurrency,
	deleteCustomCurrency,
	listCurrenciesForGroup,
	CurrencyImmutableError,
	CurrencyInUseError,
	CurrencyNotFoundError,
	DuplicateDisplayCodeError
} from '$lib/server/currencies';
import { currencies } from '$lib/server/db/currencies-schema';
import { transactions } from '$lib/server/db/transactions-schema';
import { auditLog } from '$lib/server/db/audit-schema';
import { members } from '$lib/server/db/groups-schema';
import { CURRENCIES } from '$lib/money';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration, IT_PREFIX } from './helpers';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

describeIntegration('integration: custom-currency service (issue #61; PLAN §7.5.2)', () => {
	let userA: { id: string; name: string };
	let userB: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
		userB = await createTestUser('b');
	});

	afterEach(async () => {
		await db.execute(sql`
			delete from transactions
			where group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await db.execute(sql`
			delete from currencies
			where created_by like ${IT_PREFIX + '%'}
			   or group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await cleanupSuiteRows();
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	/** A group owned by `userA`, settling in THB (never a custom currency — ADR-0014 #1). */
	async function freshGroup(label = 'g') {
		return createGroup({
			userId: userA.id,
			userName: userA.name,
			name: `${IT_PREFIX}${label}`,
			settlementCurrency: 'THB'
		});
	}

	/** `userA`'s member id in the group (payer / beneficiary for a real transaction). */
	async function creatorMemberId(groupId: string): Promise<string> {
		const [row] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, groupId), eq(members.userId, userA.id)));
		return row.id;
	}

	/** Count this group's audit rows (the delta basis for "exactly one new row"). */
	async function auditCount(groupId: string): Promise<number> {
		const rows = await db.select().from(auditLog).where(eq(auditLog.groupId, groupId));
		return rows.length;
	}

	/** This group's custom currency rows, as stored. */
	async function customRows(groupId: string) {
		return db.select().from(currencies).where(eq(currencies.groupId, groupId));
	}

	/**
	 * Record a REAL transaction in the given (custom) entry currency, straight
	 * through the ledger tables. Deliberately NOT via `createTransaction`: the
	 * transaction service still gates entry currencies on `currencyCodeSchema` and
	 * only learns about group-scoped currencies in #63. What the lock needs is a real
	 * `transactions.currency → currencies.code` reference, which this is.
	 */
	async function recordTransactionIn(groupId: string, code: string) {
		const [txn] = await db
			.insert(transactions)
			.values({
				groupId,
				type: 'spending',
				title: 'Three beers',
				categoryId: SPENDING_CATEGORY,
				amountTotal: 3,
				currency: code,
				// Always foreign, so a rate is always required (ADR-0014 decision 6).
				exchangeRate: '250',
				amountTotalSettlement: 75_000,
				splitMode: 'equal',
				createdBy: userA.id
			})
			.returning();
		return txn;
	}

	// ── 1. Create + audit atomicity (§12.1) ───────────────────────────────────

	it('creates a custom currency with a minted opaque code and exactly one audit row', async () => {
		const group = await freshGroup();
		const before = await auditCount(group.id);

		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'beer', name: 'Bottle of beer', symbol: '🍺', exponent: 0 }
		});

		// The code is generated, opaque, and NOT what the member typed (§7.5.2).
		expect(row.code.startsWith('cur_')).toBe(true);
		expect(row.code).not.toBe('BEER');
		// …and the display code was normalized (trimmed + uppercased).
		expect(row.displayCode).toBe('BEER');
		expect(row.groupId).toBe(group.id);
		expect(row.createdBy).toBe(userA.id);
		expect(row.createdAt).toBeInstanceOf(Date);

		// Exactly ONE new audit row, written in the same transaction.
		expect((await auditCount(group.id)) - before).toBe(1);
		const [entry] = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.entityType, 'currency'), eq(auditLog.entityId, row.code)));
		expect(entry.action).toBe('create');
		expect(entry.actorUserId).toBe(userA.id);
		expect(entry.groupId).toBe(group.id);
		// Durable denormalized label — readable after the row is edited or deleted.
		expect(entry.summary).toContain('BEER');
		expect(entry.occurredAt).toBeInstanceOf(Date);
	});

	it('a FAILED create leaves NEITHER a currency row NOR an audit row (§12.1 atomicity)', async () => {
		const group = await freshGroup();
		await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 0 }
		});
		const currenciesBefore = await customRows(group.id);
		const auditBefore = await auditCount(group.id);

		// Same display code again — refused inside the transaction.
		await expect(
			createCustomCurrency({
				userId: userA.id,
				groupId: group.id,
				input: { displayCode: 'BEER', name: 'Another beer', symbol: '🍻', exponent: 2 }
			})
		).rejects.toBeInstanceOf(DuplicateDisplayCodeError);

		expect(await customRows(group.id)).toHaveLength(currenciesBefore.length);
		expect(await auditCount(group.id)).toBe(auditBefore);
	});

	it('a create rejected for NO ACCESS writes neither row', async () => {
		const group = await freshGroup();
		const auditBefore = await auditCount(group.id);

		await expect(
			createCustomCurrency({
				userId: userB.id, // not a member
				groupId: group.id,
				input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
			})
		).rejects.toBeInstanceOf(GroupAccessError);

		expect(await customRows(group.id)).toHaveLength(0);
		expect(await auditCount(group.id)).toBe(auditBefore);
	});

	// ── 2. Duplicate display codes are GROUP-scoped ───────────────────────────

	it('rejects a duplicate display code within a group, and says it was a custom clash', async () => {
		const group = await freshGroup();
		await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});

		const err = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			// Lowercase — normalization must not let the same code in twice.
			input: { displayCode: 'beer', name: 'Beer again', symbol: '🍻', exponent: 0 }
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(DuplicateDisplayCodeError);
		expect((err as DuplicateDisplayCodeError).conflictsWith).toBe('custom');
		expect(await customRows(group.id)).toHaveLength(1);
	});

	it('accepts the SAME display code in a DIFFERENT group', async () => {
		const groupA = await freshGroup('ga');
		const groupB = await freshGroup('gb');

		const a = await createCustomCurrency({
			userId: userA.id,
			groupId: groupA.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		const b = await createCustomCurrency({
			userId: userA.id,
			groupId: groupB.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});

		expect(a.displayCode).toBe('BEER');
		expect(b.displayCode).toBe('BEER');
		expect(a.code).not.toBe(b.code);
	});

	it('rejects a display code that shadows a SEEDED code, and says so', async () => {
		const group = await freshGroup();

		const err = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'USD', name: 'Arcade dollar', symbol: '$', exponent: 2 }
		}).catch((e: unknown) => e);

		// The unique index permits this (seeded rows have `group_id IS NULL`); the
		// SERVICE refuses it, because the picker unions both sets and two rows reading
		// `USD` would be unresolvable.
		expect(err).toBeInstanceOf(DuplicateDisplayCodeError);
		expect((err as DuplicateDisplayCodeError).conflictsWith).toBe('seeded');
		expect(await customRows(group.id)).toHaveLength(0);
	});

	// ── 3. THE IMMUTABILITY LOCK (ADR-0014 decision 5) ────────────────────────

	it('accepts an exponent + displayCode edit BEFORE the first referencing transaction', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});

		const updated = await updateCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			code: row.code,
			input: { displayCode: 'PINT', exponent: 2 }
		});

		expect(updated.displayCode).toBe('PINT');
		expect(updated.exponent).toBe(2);
		// The opaque PK never moves — that is why editing the display code is safe here.
		expect(updated.code).toBe(row.code);
	});

	it('REFUSES an exponent / displayCode edit once a transaction references the row', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		await recordTransactionIn(group.id, row.code);

		const exponentErr = await updateCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			code: row.code,
			input: { exponent: 2 }
		}).catch((e: unknown) => e);
		expect(exponentErr).toBeInstanceOf(CurrencyImmutableError);
		expect((exponentErr as CurrencyImmutableError).fields).toEqual(['exponent']);

		const codeErr = await updateCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			code: row.code,
			input: { displayCode: 'PINT' }
		}).catch((e: unknown) => e);
		expect(codeErr).toBeInstanceOf(CurrencyImmutableError);
		expect((codeErr as CurrencyImmutableError).fields).toEqual(['displayCode']);

		// The stored row is UNTOUCHED — this is the whole point: every amount already
		// recorded against it keeps the exponent it was entered under.
		const [after] = await db.select().from(currencies).where(eq(currencies.code, row.code));
		expect(after.exponent).toBe(0);
		expect(after.displayCode).toBe('BEER');
	});

	it('still accepts a name / symbol edit AFTER the row is referenced', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		await recordTransactionIn(group.id, row.code);

		const before = await auditCount(group.id);
		const updated = await updateCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			code: row.code,
			// The frozen fields come back UNCHANGED with the rest of the form.
			input: { displayCode: 'BEER', name: 'Pint of beer', symbol: '🍻', exponent: 0 }
		});

		expect(updated.name).toBe('Pint of beer');
		expect(updated.symbol).toBe('🍻');
		expect(updated.exponent).toBe(0);
		// One `edit` audit row, in the same transaction.
		expect((await auditCount(group.id)) - before).toBe(1);
		const entries = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.entityId, row.code), eq(auditLog.action, 'edit')));
		expect(entries).toHaveLength(1);
		expect(entries[0].summary).toContain('BEER');
	});

	it('an all-fields-IDENTICAL resubmission writes NOTHING (no phantom "Edited" entry)', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		const before = await auditCount(group.id);

		// Opening the edit form and pressing Save unchanged — the whole form comes back
		// with values identical to the stored row.
		const returned = await updateCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			code: row.code,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});

		expect(returned.code).toBe(row.code);
		expect(returned.name).toBe('Beer');
		// The §12.1 accountability feed must not claim an edit that didn't happen.
		expect(await auditCount(group.id)).toBe(before);
		const edits = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.entityId, row.code), eq(auditLog.action, 'edit')));
		expect(edits).toHaveLength(0);
	});

	it('a REFUSED edit writes no audit row', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		await recordTransactionIn(group.id, row.code);
		const before = await auditCount(group.id);

		await expect(
			updateCustomCurrency({
				userId: userA.id,
				groupId: group.id,
				code: row.code,
				input: { exponent: 3 }
			})
		).rejects.toBeInstanceOf(CurrencyImmutableError);

		expect(await auditCount(group.id)).toBe(before);
	});

	it("cannot edit another group's currency (or a seeded row) — not-found", async () => {
		const groupA = await freshGroup('ga');
		const groupB = await freshGroup('gb');
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: groupA.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});

		// Same user, a group they DO belong to — but the currency is not that group's.
		await expect(
			updateCustomCurrency({
				userId: userA.id,
				groupId: groupB.id,
				code: row.code,
				input: { name: 'Hijacked' }
			})
		).rejects.toBeInstanceOf(CurrencyNotFoundError);

		// And a SEEDED row is nobody's to edit.
		await expect(
			updateCustomCurrency({
				userId: userA.id,
				groupId: groupA.id,
				code: 'USD',
				input: { name: 'Not a dollar' }
			})
		).rejects.toBeInstanceOf(CurrencyNotFoundError);

		const [seededUsd] = await db.select().from(currencies).where(eq(currencies.code, 'USD'));
		expect(seededUsd.name).toBe('US Dollar');
	});

	// ── 4. Delete — only while unreferenced ───────────────────────────────────

	it('deletes an unreferenced currency and writes one delete audit row', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		const before = await auditCount(group.id);

		await deleteCustomCurrency({ userId: userA.id, groupId: group.id, code: row.code });

		expect(await customRows(group.id)).toHaveLength(0);
		expect((await auditCount(group.id)) - before).toBe(1);
		const [entry] = await db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.entityId, row.code), eq(auditLog.action, 'delete')));
		// The row is gone, so the trail must carry its label (§12.1 denormalize).
		expect(entry.summary).toContain('BEER');
		// …and the earlier `create` entry is still there (append-only).
		const all = await db.select().from(auditLog).where(eq(auditLog.entityId, row.code));
		expect(all.map((e) => e.action).sort()).toEqual(['create', 'delete']);
	});

	it('REFUSES to delete once a transaction references it, and writes no audit row', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		await recordTransactionIn(group.id, row.code);
		const before = await auditCount(group.id);

		await expect(
			deleteCustomCurrency({ userId: userA.id, groupId: group.id, code: row.code })
		).rejects.toBeInstanceOf(CurrencyInUseError);

		expect(await customRows(group.id)).toHaveLength(1);
		expect(await auditCount(group.id)).toBe(before);
	});

	// ── 5. listCurrenciesForGroup — the 29 plus THIS group's rows ─────────────

	it("returns the 29 seeded rows plus only this group's custom rows", async () => {
		const groupA = await freshGroup('ga');
		const groupB = await freshGroup('gb');
		await createCustomCurrency({
			userId: userA.id,
			groupId: groupA.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});
		await createCustomCurrency({
			userId: userA.id,
			groupId: groupB.id,
			input: { displayCode: 'ROUNDS', name: 'Round', symbol: 'R', exponent: 0 }
		});

		const list = await listCurrenciesForGroup({ userId: userA.id, groupId: groupA.id });

		expect(list).toHaveLength(CURRENCIES.length + 1);
		const custom = list.filter((c) => c.isCustom);
		expect(custom.map((c) => c.displayCode)).toEqual(['BEER']);
		// Group B's currency is NOT visible here.
		expect(list.map((c) => c.displayCode)).not.toContain('ROUNDS');
		// The seeded block comes first, complete and in PLAN §7.5.1 order.
		expect(list.slice(0, CURRENCIES.length).map((c) => c.code)).toEqual(
			CURRENCIES.map((c) => c.code)
		);
		// A seeded row keeps `code == display_code` and a NULL group.
		expect(list[0].groupId).toBeNull();
	});

	it('is exactly the seeded table for a group that never defined a currency', async () => {
		const group = await freshGroup();
		const list = await listCurrenciesForGroup({ userId: userA.id, groupId: group.id });
		expect(list).toHaveLength(CURRENCIES.length);
		expect(list.every((c) => !c.isCustom)).toBe(true);

		const seeded = await db.select().from(currencies).where(isNull(currencies.groupId));
		expect(seeded).toHaveLength(CURRENCIES.length);
	});

	// ── 6. Membership (§12) on all four operations, against real member rows ──

	it('refuses all four operations for a non-member', async () => {
		const group = await freshGroup();
		const row = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
		});

		await expect(
			createCustomCurrency({
				userId: userB.id,
				groupId: group.id,
				input: { displayCode: 'PINT', name: 'Pint', symbol: 'P', exponent: 0 }
			})
		).rejects.toBeInstanceOf(GroupAccessError);
		await expect(
			updateCustomCurrency({
				userId: userB.id,
				groupId: group.id,
				code: row.code,
				input: { name: 'Hijacked' }
			})
		).rejects.toBeInstanceOf(GroupAccessError);
		await expect(
			deleteCustomCurrency({ userId: userB.id, groupId: group.id, code: row.code })
		).rejects.toBeInstanceOf(GroupAccessError);
		await expect(
			listCurrenciesForGroup({ userId: userB.id, groupId: group.id })
		).rejects.toBeInstanceOf(GroupAccessError);

		// Nothing moved.
		const [after] = await db.select().from(currencies).where(eq(currencies.code, row.code));
		expect(after.name).toBe('Beer');
	});

	it('refuses every operation once the acting member is deactivated (§12 access primitive)', async () => {
		const group = await freshGroup();
		const memberId = await creatorMemberId(group.id);
		await db.update(members).set({ deactivatedAt: new Date() }).where(eq(members.id, memberId));

		await expect(
			listCurrenciesForGroup({ userId: userA.id, groupId: group.id })
		).rejects.toBeInstanceOf(GroupAccessError);
		await expect(
			createCustomCurrency({
				userId: userA.id,
				groupId: group.id,
				input: { displayCode: 'BEER', name: 'Beer', symbol: '🍺', exponent: 0 }
			})
		).rejects.toBeInstanceOf(GroupAccessError);
	});
});
