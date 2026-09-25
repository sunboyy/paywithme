// Real-DB integration tests — the transaction WRITE module (PLAN §7.1, §7.2, §7.6,
// §9, §12.1, §16.2): `createTransaction`, `updateTransaction`,
// `softDeleteTransaction` and `restoreTransaction`, through their own interface.
//
// Each write returns the persisted detail, read back inside its own transaction, so
// most assertions read that return value. The rest read the real rows: the audit
// log, the columns the detail does not carry, and what a rejected write left behind.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import { createCustomCurrency } from '$lib/server/currencies';
import {
	createTransaction,
	updateTransaction,
	softDeleteTransaction,
	restoreTransaction,
	TransactionDeletedError,
	TransactionNotFoundError,
	TransactionValidationError
} from '$lib/server/transactions';
import { GroupAccessError } from '$lib/server/groups';
import { UNSUPPORTED_CURRENCY_MESSAGE } from '$lib/schemas/currency';
import { applyCharges, convertToSettlement, type ChargeInput } from '$lib/schemas/transaction';
import { resolveItemizedWithCharges } from '$lib/transactions/resolve';
import { auditLog } from '$lib/server/db/audit-schema';
import { groups, members } from '$lib/server/db/groups-schema';
import { transactionPayers, transactions } from '$lib/server/db/transactions-schema';
import { IT_PREFIX, cleanupSuiteRows, createTestUser, db, describeIntegration } from './helpers';

const FOOD = 'spending-food-drink';

describeIntegration('integration: transaction writes (PLAN §7, §9, §12.1)', () => {
	let user: { id: string; name: string };
	let groupId: string;
	let a: string;
	let b: string;
	let c: string;

	beforeEach(async () => {
		user = await createTestUser('writes');
		const group = await createGroup({
			userId: user.id,
			userName: user.name,
			name: 'Trip',
			settlementCurrency: 'THB'
		});
		groupId = group.id;
		const [creator] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, groupId), eq(members.userId, user.id)));
		a = creator.id;
		b = (await addMember({ userId: user.id, groupId, displayName: 'Bob' })).id;
		c = (await addMember({ userId: user.id, groupId, displayName: 'Cam' })).id;
	});

	afterEach(async () => {
		await db.execute(sql`
			delete from transactions
			where group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await db.execute(sql`
			delete from currencies
			where group_id in (select id from groups where created_by like ${IT_PREFIX + '%'})
		`);
		await cleanupSuiteRows();
	});

	/** ฿90.00 paid by A, split equally between A and B. */
	function equalInput() {
		return {
			type: 'spending' as const,
			title: 'Dinner',
			categoryId: FOOD,
			amountTotal: 9000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 9000,
			splitMode: 'equal' as const,
			payers: [{ memberId: a, amountPaid: 9000 }],
			beneficiaries: [{ memberId: a }, { memberId: b }],
			items: [],
			charges: []
		};
	}

	function create(input: unknown, extra: Record<string, unknown> = {}) {
		return createTransaction({
			userId: user.id,
			groupId,
			input,
			settlementCurrency: 'THB',
			...extra
		});
	}

	function update(txnId: string, input: unknown, extra: Record<string, unknown> = {}) {
		return updateTransaction({
			userId: user.id,
			groupId,
			txnId,
			input,
			settlementCurrency: 'THB',
			...extra
		});
	}

	async function txnRow(txnId: string) {
		const [row] = await db.select().from(transactions).where(eq(transactions.id, txnId));
		return row;
	}

	async function txnCount() {
		const rows = await db
			.select({ id: transactions.id })
			.from(transactions)
			.where(eq(transactions.groupId, groupId));
		return rows.length;
	}

	async function auditRows(txnId: string) {
		return db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.entityType, 'transaction'), eq(auditLog.entityId, txnId)))
			.orderBy(auditLog.occurredAt);
	}

	async function paidSettlement(txnId: string) {
		const rows = await db
			.select({ amountPaidSettlement: transactionPayers.amountPaidSettlement })
			.from(transactionPayers)
			.where(eq(transactionPayers.transactionId, txnId));
		return rows.map((r) => r.amountPaidSettlement);
	}

	const owed = (shares: { amountOwed: number }[]) => shares.reduce((s, x) => s + x.amountOwed, 0);

	// ── createTransaction ──────────────────────────────────────────────────────

	describe('createTransaction', () => {
		it('returns the persisted transaction, with its audit row', async () => {
			const detail = await create(equalInput());

			expect(detail).toMatchObject({
				groupId,
				title: 'Dinner',
				amountTotal: 9000,
				amountTotalSettlement: 9000,
				payers: [{ memberId: a, amountPaid: 9000 }]
			});
			expect(detail.shares).toHaveLength(2);
			const audit = await auditRows(detail.id);
			expect(audit.map((r) => r.action)).toEqual(['create']);
			expect(audit[0].actorUserId).toBe(user.id);
			expect(audit[0].summary).toContain('Dinner');
			expect(audit[0].summary).toContain('90.00');
		});

		it('writes nothing when a same-transaction follow-up fails (§12.1)', async () => {
			await expect(
				create(equalInput(), {
					alsoWrite: async () => {
						throw new Error('follow-up failed');
					}
				})
			).rejects.toThrow('follow-up failed');

			expect(await txnCount()).toBe(0);
			const audit = await db.select().from(auditLog).where(eq(auditLog.groupId, groupId));
			expect(audit.filter((r) => r.entityType === 'transaction')).toEqual([]);
		});

		it('throws GroupAccessError for a non-member and writes nothing', async () => {
			const outsider = await createTestUser('outsider');
			await expect(
				createTransaction({ userId: outsider.id, groupId, input: equalInput() })
			).rejects.toBeInstanceOf(GroupAccessError);
			expect(await txnCount()).toBe(0);
		});

		it('re-resolves an EQUAL split server-side', async () => {
			const detail = await create(equalInput());
			expect(detail.shares).toEqual(
				[
					{ memberId: a, amountOwed: 4500 },
					{ memberId: b, amountOwed: 4500 }
				].sort((x, y) => x.memberId.localeCompare(y.memberId))
			);
		});

		it('re-resolves a SHARE split and keeps the weights for re-editing', async () => {
			const detail = await create({
				...equalInput(),
				splitMode: 'share',
				beneficiaries: [
					{ memberId: a, shareWeight: 1 },
					{ memberId: b, shareWeight: 2 }
				]
			});
			const byMember = new Map(detail.shares.map((s) => [s.memberId, s.amountOwed]));
			expect(byMember.get(a)).toBe(3000);
			expect(byMember.get(b)).toBe(6000);
			expect(detail.input.beneficiaries).toEqual(
				expect.arrayContaining([
					{ memberId: a, shareWeight: 1 },
					{ memberId: b, shareWeight: 2 }
				])
			);
		});

		it('re-resolves an AMOUNT split and keeps the raw amounts', async () => {
			const detail = await create({
				...equalInput(),
				splitMode: 'amount',
				beneficiaries: [
					{ memberId: a, rawAmount: 2000 },
					{ memberId: b, rawAmount: 7000 }
				]
			});
			const byMember = new Map(detail.shares.map((s) => [s.memberId, s.amountOwed]));
			expect(byMember.get(a)).toBe(2000);
			expect(byMember.get(b)).toBe(7000);
			expect(detail.input.beneficiaries).toEqual(
				expect.arrayContaining([
					{ memberId: a, rawAmount: 2000 },
					{ memberId: b, rawAmount: 7000 }
				])
			);
		});

		it('in the settlement currency: rate 1, settlement totals mirror the entry totals', async () => {
			const detail = await create(equalInput());
			const row = await txnRow(detail.id);
			expect(Number(row.exchangeRate)).toBe(1);
			expect(row.amountTotalSettlement).toBe(9000);
			expect(await paidSettlement(detail.id)).toEqual([9000]);
		});

		it('in a FOREIGN currency: keeps currency + rate and recomputes the settlement total (§7.6)', async () => {
			const settlementTotal = convertToSettlement(9000, 'CNY', 'THB', '4.85');
			expect(settlementTotal).toBe(43650);

			const detail = await create({
				...equalInput(),
				currency: 'CNY',
				exchangeRate: '4.85',
				amountTotalSettlement: settlementTotal
			});

			expect(detail).toMatchObject({ currency: 'CNY', amountTotal: 9000, isForeign: true });
			expect(Number((await txnRow(detail.id)).exchangeRate)).toBe(4.85);
			expect(detail.amountTotalSettlement).toBe(settlementTotal);
			expect(detail.shares.map((s) => s.amountOwed)).toEqual([21825, 21825]);
			expect(detail.payers).toEqual([{ memberId: a, amountPaid: 9000 }]);
			expect(await paidSettlement(detail.id)).toEqual([settlementTotal]);
		});

		it('rejects a wrong client settlement total and writes nothing', async () => {
			await expect(
				create({ ...equalInput(), currency: 'CNY', exchangeRate: '4.85', amountTotalSettlement: 1 })
			).rejects.toBeInstanceOf(TransactionValidationError);
			expect(await txnCount()).toBe(0);
		});

		it('stores the editable date at noon UTC; occurred_at is the insert time (§7.1)', async () => {
			const before = Date.now();
			const detail = await create({ ...equalInput(), date: '2026-01-02' });
			expect(detail.createdAt).toBe('2026-01-02T12:00:00.000Z');
			const row = await txnRow(detail.id);
			expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
		});

		it('rejects Σ paid ≠ total, and a beneficiary who is not an active member', async () => {
			await expect(
				create({ ...equalInput(), payers: [{ memberId: a, amountPaid: 1 }] })
			).rejects.toBeInstanceOf(TransactionValidationError);
			await expect(
				create({ ...equalInput(), beneficiaries: [{ memberId: 'ghost' }] })
			).rejects.toBeInstanceOf(TransactionValidationError);
			expect(await txnCount()).toBe(0);
		});
	});

	// ── itemized + charges ─────────────────────────────────────────────────────

	describe('createTransaction — itemized (§7.2.1-3)', () => {
		/** Pizza 100 (A/B equal) + Wine 10 (A:1, B:2 share), then optional charges. */
		function itemizedInput(charges: ChargeInput[] = []) {
			const items = [
				{
					label: 'Pizza',
					amount: 100,
					splitMode: 'equal' as const,
					beneficiaries: [{ memberId: a }, { memberId: b }]
				},
				{
					label: 'Wine',
					amount: 10,
					splitMode: 'share' as const,
					beneficiaries: [
						{ memberId: a, shareWeight: 1 },
						{ memberId: b, shareWeight: 2 }
					]
				}
			];
			const amountTotal = applyCharges(110, charges).amountTotal;
			return {
				type: 'spending' as const,
				title: 'Group dinner',
				categoryId: FOOD,
				amountTotal,
				currency: 'THB',
				exchangeRate: '1',
				amountTotalSettlement: amountTotal,
				splitMode: 'itemized' as const,
				payers: [{ memberId: a, amountPaid: amountTotal }],
				beneficiaries: [],
				items,
				charges
			};
		}

		const CHARGES: ChargeInput[] = [
			{ kind: 'service', mode: 'percent', value: 1000, base: 'items_subtotal', sortOrder: 0 },
			{ kind: 'discount', mode: 'absolute', value: 5, base: 'running_total', sortOrder: 1 }
		];

		it('persists items in order with their per-item splits', async () => {
			const detail = await create(itemizedInput());

			expect(detail.items.map((i) => ({ label: i.label, amount: i.amount }))).toEqual([
				{ label: 'Pizza', amount: 100 },
				{ label: 'Wine', amount: 10 }
			]);
			const [pizza, wine] = detail.items;
			expect(pizza.splitMode).toBe('equal');
			expect(new Map(pizza.shares.map((s) => [s.memberId, s.amountOwed]))).toEqual(
				new Map([
					[a, 50],
					[b, 50]
				])
			);
			expect(wine.splitMode).toBe('share');
			expect(new Map(wine.shares.map((s) => [s.memberId, s.amountOwed]))).toEqual(
				new Map([
					[a, 3],
					[b, 7]
				])
			);
			expect(detail.input.items[1].beneficiaries).toEqual(
				expect.arrayContaining([
					{ memberId: a, shareWeight: 1 },
					{ memberId: b, shareWeight: 2 }
				])
			);
		});

		it('aggregates shares across items and they sum to the total', async () => {
			const detail = await create(itemizedInput());
			const byMember = new Map(detail.shares.map((s) => [s.memberId, s.amountOwed]));
			expect(byMember.get(a)).toBe(53);
			expect(byMember.get(b)).toBe(57);
			expect(owed(detail.shares)).toBe(110);
		});

		it('rejects an itemized TRANSFER (§7.2.3)', async () => {
			await expect(
				create({ ...itemizedInput(), type: 'transfer', categoryId: 'transfer-debt-settlement' })
			).rejects.toBeInstanceOf(TransactionValidationError);
			expect(await txnCount()).toBe(0);
		});

		it('persists charges in order, and shares reflect them', async () => {
			const input = itemizedInput(CHARGES);
			const detail = await create(input);

			expect(detail.charges).toEqual(CHARGES);
			const expected = resolveItemizedWithCharges(input.items, CHARGES);
			expect(new Map(detail.shares.map((s) => [s.memberId, s.amountOwed]))).toEqual(
				new Map(expected.shares.map((s) => [s.memberId, s.amountOwed]))
			);
			expect(owed(detail.shares)).toBe(116);
			expect(detail.amountTotal).toBe(116);
		});

		it('in a FOREIGN currency: settlement shares and payers sum to the settlement total', async () => {
			const settlementTotal = convertToSettlement(116, 'CNY', 'THB', '4.85');
			expect(settlementTotal).toBe(563);

			const detail = await create({
				...itemizedInput(CHARGES),
				currency: 'CNY',
				exchangeRate: '4.85',
				amountTotalSettlement: settlementTotal
			});

			expect(detail).toMatchObject({ currency: 'CNY', amountTotal: 116 });
			expect(owed(detail.shares)).toBe(settlementTotal);
			expect(await paidSettlement(detail.id)).toEqual([settlementTotal]);
		});
	});

	// ── updateTransaction ──────────────────────────────────────────────────────

	describe('updateTransaction', () => {
		it('returns the transaction before and after the edit', async () => {
			const created = await create(equalInput());
			const { before, after } = await update(created.id, { ...equalInput(), title: 'Lunch' });
			expect(before.title).toBe('Dinner');
			expect(after.title).toBe('Lunch');
			expect(after.id).toBe(created.id);
		});

		it('updates the row: created_at from the date, updated_at bumped, occurred_at kept', async () => {
			const created = await create(equalInput());
			const original = await txnRow(created.id);
			const when = new Date('2026-05-05T05:05:05.000Z');

			const { after } = await update(
				created.id,
				{ ...equalInput(), title: 'Lunch', date: '2026-01-02' },
				{ now: () => when }
			);

			expect(after.createdAt).toBe('2026-01-02T12:00:00.000Z');
			const row = await txnRow(created.id);
			expect(row.updatedAt).toEqual(when);
			expect(row.occurredAt).toEqual(original.occurredAt);
		});

		it('keeps the stored rounding ordinal and allocates none', async () => {
			const threeWay = {
				...equalInput(),
				amountTotal: 10_000,
				amountTotalSettlement: 10_000,
				payers: [{ memberId: a, amountPaid: 10_000 }],
				beneficiaries: [{ memberId: a }, { memberId: b }, { memberId: c }]
			};
			await create(threeWay);
			const second = await create(threeWay);
			const holder = second.shares.find((s) => s.amountOwed === 3334)!.memberId;
			const [counter] = await db
				.select({ next: groups.nextRoundingSeq })
				.from(groups)
				.where(eq(groups.id, groupId));

			const { after } = await update(second.id, { ...threeWay, title: 'Renamed' });

			expect(after.shares.find((s) => s.amountOwed === 3334)!.memberId).toBe(holder);
			const [counterAfter] = await db
				.select({ next: groups.nextRoundingSeq })
				.from(groups)
				.where(eq(groups.id, groupId));
			expect(counterAfter.next).toBe(counter.next);
			expect((await txnRow(second.id)).roundingSeq).toBe(1);
		});

		it('replaces every child row: an itemized bill edited to an equal split loses its items', async () => {
			const created = await create({
				...equalInput(),
				amountTotal: 100,
				amountTotalSettlement: 100,
				payers: [{ memberId: a, amountPaid: 100 }],
				splitMode: 'itemized',
				beneficiaries: [],
				items: [
					{ label: 'Pizza', amount: 100, splitMode: 'equal', beneficiaries: [{ memberId: c }] }
				],
				charges: [
					{ kind: 'discount', mode: 'absolute', value: 0, base: 'running_total', sortOrder: 0 }
				]
			});
			expect(created.items).toHaveLength(1);

			const { after } = await update(created.id, equalInput());

			expect(after.items).toEqual([]);
			expect(after.charges).toEqual([]);
			expect(after.shares.map((s) => s.memberId).sort()).toEqual([a, b].sort());
		});

		it('re-resolves settlement amounts server-side', async () => {
			const created = await create(equalInput());
			const { after } = await update(created.id, {
				...equalInput(),
				splitMode: 'share',
				beneficiaries: [
					{ memberId: a, shareWeight: 1 },
					{ memberId: b, shareWeight: 2 }
				]
			});
			const byMember = new Map(after.shares.map((s) => [s.memberId, s.amountOwed]));
			expect(byMember.get(a)).toBe(3000);
			expect(byMember.get(b)).toBe(6000);
		});

		it('writes an `edit` audit row carrying the title before and after', async () => {
			const created = await create(equalInput());
			await update(created.id, { ...equalInput(), title: 'Lunch' });

			const audit = await auditRows(created.id);
			expect(audit.map((r) => r.action)).toEqual(['create', 'edit']);
			expect(audit[1].summary).toContain('Lunch');
			expect(audit[1].metadata).toMatchObject({
				before: { title: 'Dinner' },
				after: { title: 'Lunch' }
			});
		});

		it('refuses a soft-deleted transaction and changes nothing', async () => {
			const created = await create(equalInput());
			await softDeleteTransaction({ userId: user.id, groupId, txnId: created.id });

			await expect(update(created.id, { ...equalInput(), title: 'Lunch' })).rejects.toBeInstanceOf(
				TransactionDeletedError
			);
			expect((await txnRow(created.id)).title).toBe('Dinner');
		});

		it('rejects invalid input and changes nothing', async () => {
			const created = await create(equalInput());
			await expect(
				update(created.id, { ...equalInput(), payers: [{ memberId: a, amountPaid: 1 }] })
			).rejects.toBeInstanceOf(TransactionValidationError);
			expect((await auditRows(created.id)).map((r) => r.action)).toEqual(['create']);
		});

		it("throws TransactionNotFoundError for another group's transaction", async () => {
			const other = await createGroup({
				userId: user.id,
				userName: user.name,
				name: 'Other',
				settlementCurrency: 'THB'
			});
			const created = await create(equalInput());

			await expect(
				updateTransaction({
					userId: user.id,
					groupId: other.id,
					txnId: created.id,
					input: equalInput()
				})
			).rejects.toBeInstanceOf(TransactionNotFoundError);
		});

		it('throws GroupAccessError for a non-member', async () => {
			const created = await create(equalInput());
			const outsider = await createTestUser('outsider');
			await expect(
				updateTransaction({
					userId: outsider.id,
					groupId,
					txnId: created.id,
					input: equalInput()
				})
			).rejects.toBeInstanceOf(GroupAccessError);
		});
	});

	// ── softDeleteTransaction / restoreTransaction ─────────────────────────────

	describe('softDeleteTransaction / restoreTransaction', () => {
		it('delete stamps deleted_at, audits, and returns the deleted transaction', async () => {
			const created = await create(equalInput());
			const when = new Date('2026-06-01T00:00:00.000Z');

			const result = await softDeleteTransaction({
				userId: user.id,
				groupId,
				txnId: created.id,
				now: () => when
			});

			expect(result.changed).toBe(true);
			expect(result.detail.deletedAt).toBe(when.toISOString());
			expect((await auditRows(created.id)).map((r) => r.action)).toEqual(['create', 'delete']);
		});

		it('restore clears deleted_at and audits', async () => {
			const created = await create(equalInput());
			await softDeleteTransaction({ userId: user.id, groupId, txnId: created.id });

			const result = await restoreTransaction({ userId: user.id, groupId, txnId: created.id });

			expect(result.changed).toBe(true);
			expect(result.detail.deletedAt).toBeNull();
			expect((await auditRows(created.id)).map((r) => r.action)).toEqual([
				'create',
				'delete',
				'restore'
			]);
		});

		it('a repeated delete or restore changes nothing and writes no audit row (§16.6)', async () => {
			const created = await create(equalInput());
			const first = new Date('2026-06-01T00:00:00.000Z');
			await softDeleteTransaction({
				userId: user.id,
				groupId,
				txnId: created.id,
				now: () => first
			});

			const again = await softDeleteTransaction({ userId: user.id, groupId, txnId: created.id });
			expect(again.changed).toBe(false);
			expect(again.detail.deletedAt).toBe(first.toISOString());

			await restoreTransaction({ userId: user.id, groupId, txnId: created.id });
			const restoredAgain = await restoreTransaction({
				userId: user.id,
				groupId,
				txnId: created.id
			});
			expect(restoredAgain.changed).toBe(false);

			expect((await auditRows(created.id)).map((r) => r.action)).toEqual([
				'create',
				'delete',
				'restore'
			]);
		});

		it('both are access-checked and group-scoped', async () => {
			const created = await create(equalInput());
			const outsider = await createTestUser('outsider');

			await expect(
				softDeleteTransaction({ userId: outsider.id, groupId, txnId: created.id })
			).rejects.toBeInstanceOf(GroupAccessError);
			await expect(
				restoreTransaction({ userId: outsider.id, groupId, txnId: created.id })
			).rejects.toBeInstanceOf(GroupAccessError);
			await expect(
				softDeleteTransaction({ userId: user.id, groupId, txnId: 'nope' })
			).rejects.toBeInstanceOf(TransactionNotFoundError);
			expect((await txnRow(created.id)).deletedAt).toBeNull();
		});
	});

	// ── API-key audit provenance (§16.2) ───────────────────────────────────────

	describe('audit provenance', () => {
		const VIA = { keyId: 'key_abc', keyName: 'agent key' };

		it('create: metadata carries the key, the summary says so, the actor stays the user', async () => {
			const created = await create(equalInput(), { via: VIA });
			const [audit] = await auditRows(created.id);
			expect(audit.actorUserId).toBe(user.id);
			expect(audit.metadata).toMatchObject({
				viaKey: 'key_abc',
				keyName: 'agent key',
				type: 'spending',
				splitMode: 'equal'
			});
			expect(audit.summary).toContain("Added spending 'Dinner'");
			expect(audit.summary).toMatch(/ \(via API key 'agent key'\)$/);
		});

		it('edit, delete and restore carry it too', async () => {
			const created = await create(equalInput());
			await update(created.id, { ...equalInput(), title: 'Lunch' }, { via: VIA });
			await softDeleteTransaction({ userId: user.id, groupId, txnId: created.id, via: VIA });
			await restoreTransaction({ userId: user.id, groupId, txnId: created.id, via: VIA });

			const [, edit, del, restore] = await auditRows(created.id);
			expect(edit.metadata).toMatchObject({ viaKey: 'key_abc', before: { title: 'Dinner' } });
			expect(edit.summary).toContain("(via API key 'agent key')");
			expect(del.summary).toBe("Deleted transaction 'Lunch' (via API key 'agent key')");
			expect(restore.summary).toBe("Restored transaction 'Lunch' (via API key 'agent key')");
		});

		it('an unnamed key still gets a well-formed suffix', async () => {
			const created = await create(equalInput());
			await softDeleteTransaction({
				userId: user.id,
				groupId,
				txnId: created.id,
				via: { keyId: 'key_x', keyName: null }
			});
			const [, del] = await auditRows(created.id);
			expect(del.summary).toBe("Deleted transaction 'Dinner' (via API key 'unnamed')");
			expect(del.metadata).toMatchObject({ viaKey: 'key_x', keyName: null });
		});

		it('a web write (no `via`) records no provenance', async () => {
			const created = await create(equalInput());
			const [audit] = await auditRows(created.id);
			expect(audit.summary).not.toContain('via API key');
			expect(audit.metadata).not.toHaveProperty('viaKey');
		});
	});

	// ── A group-defined custom entry currency (§7.5.2, ADR-0014) ───────────────

	describe('custom entry currency', () => {
		let beer: string;

		beforeEach(async () => {
			beer = (
				await createCustomCurrency({
					userId: user.id,
					groupId,
					input: { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 0 }
				})
			).code;
		});

		/** 7 BEER at ฿250 = ฿1,750.00, split three ways. */
		function beerInput() {
			return {
				...equalInput(),
				amountTotal: 7,
				currency: beer,
				currencyExponent: 0,
				exchangeRate: '250',
				amountTotalSettlement: 175_000,
				payers: [{ memberId: a, amountPaid: 7 }],
				beneficiaries: [{ memberId: a }, { memberId: b }, { memberId: c }]
			};
		}

		async function issuesOf(run: () => Promise<unknown>) {
			const error = await run().catch((e) => e);
			expect(error).toBeInstanceOf(TransactionValidationError);
			return (error as TransactionValidationError).issues;
		}

		it('records the transaction under the opaque code, and shares tie out (§7.6)', async () => {
			const detail = await create(beerInput());
			expect(detail).toMatchObject({ currency: beer, amountTotal: 7 });
			expect(Number((await txnRow(detail.id)).exchangeRate)).toBe(250);
			expect(detail.amountTotalSettlement).toBe(175_000);
			expect(owed(detail.shares)).toBe(175_000);
			expect(await paidSettlement(detail.id)).toEqual([175_000]);
		});

		it('audits with the DISPLAY code, never the opaque one', async () => {
			const detail = await create(beerInput());
			const [audit] = await auditRows(detail.id);
			expect(audit.summary).toContain('BEER');
			expect(audit.summary).not.toContain(beer);
		});

		it("rejects another group's custom code", async () => {
			const other = await createGroup({
				userId: user.id,
				userName: user.name,
				name: 'Other',
				settlementCurrency: 'THB'
			});
			const theirs = await createCustomCurrency({
				userId: user.id,
				groupId: other.id,
				input: { displayCode: 'WINE', name: 'Wine', symbol: '🍷', exponent: 0 }
			});
			await expect(create({ ...beerInput(), currency: theirs.code })).rejects.toBeInstanceOf(
				TransactionValidationError
			);
			expect(await txnCount()).toBe(0);
		});

		it('accepts the display code the caller named, and rejects one that no longer matches', async () => {
			await expect(create(beerInput(), { expectedDisplayCode: 'BEER' })).resolves.toMatchObject({
				currency: beer
			});
			await expect(create(beerInput(), { expectedDisplayCode: 'PINT' })).rejects.toBeInstanceOf(
				TransactionValidationError
			);
			await expect(create(equalInput(), { expectedDisplayCode: 'THB' })).resolves.toMatchObject({
				currency: 'THB'
			});
		});

		it('a mismatched display code fails EXACTLY as an unknown code does (§7.5.2)', async () => {
			const mismatched = await issuesOf(() => create(beerInput(), { expectedDisplayCode: 'PINT' }));
			const unknown = await issuesOf(() => create({ ...beerInput(), currency: 'cur_nothing' }));
			expect(JSON.stringify(mismatched)).toBe(JSON.stringify(unknown));
			expect(mismatched[0].path).toEqual(['currency']);
			expect(mismatched[0].message).toBe(UNSUPPORTED_CURRENCY_MESSAGE);
		});

		it('an edit re-resolves at a new rate and still ties out', async () => {
			const created = await create(beerInput());
			const { after } = await update(created.id, {
				...beerInput(),
				exchangeRate: '260',
				amountTotalSettlement: 182_000
			});
			expect(after).toMatchObject({ currency: beer, amountTotalSettlement: 182_000 });
			expect(owed(after.shares)).toBe(182_000);
		});

		it('an edit is rejected when the named display code no longer matches', async () => {
			const created = await create(beerInput());
			await expect(
				update(
					created.id,
					{ ...beerInput(), exchangeRate: '260', amountTotalSettlement: 182_000 },
					{
						expectedDisplayCode: 'PINT'
					}
				)
			).rejects.toBeInstanceOf(TransactionValidationError);
			expect(Number((await txnRow(created.id)).exchangeRate)).toBe(250);
		});
	});

	// ── The member-name assertion (PR #80 review) ──────────────────────────────

	describe('member-name assertion', () => {
		const names = () =>
			new Map([
				[a, user.name],
				[b, 'Bob'],
				[c, 'Cam']
			]);

		it('accepts the write when every referenced member still has the resolved name', async () => {
			await expect(create(equalInput(), { expectedMemberNames: names() })).resolves.toBeDefined();
		});

		it('rejects the write when a referenced member has another name now', async () => {
			const stale = names().set(b, 'Someone Else');
			await expect(create(equalInput(), { expectedMemberNames: stale })).rejects.toBeInstanceOf(
				TransactionValidationError
			);
			expect(await txnCount()).toBe(0);
		});

		it('checks itemized beneficiaries too', async () => {
			const stale = names().set(b, 'Someone Else');
			const input = {
				...equalInput(),
				amountTotal: 100,
				amountTotalSettlement: 100,
				payers: [{ memberId: a, amountPaid: 100 }],
				splitMode: 'itemized',
				beneficiaries: [],
				items: [
					{
						label: 'Pizza',
						amount: 100,
						splitMode: 'equal',
						beneficiaries: [{ memberId: a }, { memberId: b }]
					}
				]
			};
			await expect(create(input, { expectedMemberNames: stale })).rejects.toBeInstanceOf(
				TransactionValidationError
			);
		});

		it('ignores a member the write never references', async () => {
			const stale = names().set(c, 'Renamed, but not in this write');
			await expect(create(equalInput(), { expectedMemberNames: stale })).resolves.toBeDefined();
		});

		it('rejects an edit when a referenced member has another name now', async () => {
			const created = await create(equalInput());
			const stale = names().set(b, 'Someone Else');
			await expect(
				update(created.id, { ...equalInput(), title: 'Lunch' }, { expectedMemberNames: stale })
			).rejects.toBeInstanceOf(TransactionValidationError);
			expect((await txnRow(created.id)).title).toBe('Dinner');
		});
	});
});
