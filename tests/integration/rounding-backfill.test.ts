// Real-DB integration tests — the ONE-SHOT ROUNDING BACKFILL (ADR-0013).
//
// `scripts/recalculate-rounding.ts` is a thin CLI over `backfillRoundingRotation`,
// so this suite is where that operation is actually proven. It matters more than
// most: the backfill REWRITES already-recorded financial rows, and the only thing
// standing between "corrects a historical unfairness" and "silently corrupts a
// settled ledger" is that these properties hold.
//
// What is asserted:
//   - a PRE-ADR-0013 history (every transaction at ordinal 0, the same member
//     absorbing every odd satang) is renumbered and re-resolved so the satang
//     rotates — the user-visible point of the exercise;
//   - Σ owed still equals the transaction total, and group balances still net to
//     exactly zero, after the rewrite;
//   - preview mode (`apply: false`) reports the same changes but writes NOTHING;
//   - it is IDEMPOTENT — a second run finds nothing to do and writes no further
//     audit rows;
//   - every rewritten transaction leaves an `audit_log` row (PLAN §12.1);
//   - the split INPUTS (share weights / raw amounts) and `updated_at` are not
//     touched — only resolved amounts move;
//   - a history recorded in a GROUP-DEFINED entry currency (PLAN §7.5.2 / ADR-0014)
//     is re-resolved at that currency's OWN exponent — the #63 widening, which
//     before it existed threw on the first custom-currency transaction it met.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import { createTransaction } from '$lib/server/transactions';
import { createCustomCurrency } from '$lib/server/currencies';
import { getGroupBalances } from '$lib/server/balances';
import { backfillRoundingRotation, resyncGroupCounters } from '$lib/server/rounding-backfill';
import { distributeEqually } from '$lib/money';
import { distributeToSettlement } from '$lib/transactions/resolve';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration, IT_PREFIX } from './helpers';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

describeIntegration('integration: rounding backfill (ADR-0013 one-shot)', () => {
	let userA: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
	});

	afterEach(async () => {
		// Custom-currency rows are group-scoped, and a transaction's `currency` points
		// at one — so both go before the groups do. (`cleanupSuiteRows` stops at
		// invites/members/groups/users by design.)
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

	function hundredBahtEqually(memberIds: string[], payerId: string, title: string) {
		return {
			type: 'spending' as const,
			title,
			categoryId: SPENDING_CATEGORY,
			amountTotal: 10_000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 10_000,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: 10_000 }],
			beneficiaries: memberIds.map((memberId) => ({ memberId })),
			items: [],
			charges: []
		};
	}

	async function groupOfThree() {
		const group = await createGroup({
			userId: userA.id,
			userName: userA.name,
			name: 'Trip',
			settlementCurrency: 'THB'
		});
		const { members } = await import('$lib/server/db/groups-schema');
		const [creator] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, group.id), eq(members.userId, userA.id)));
		const bob = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Bob' });
		const cam = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Cam' });
		return { group, memberIds: [creator.id, bob.id, cam.id] };
	}

	/**
	 * Rewind a group's transactions to the PRE-ADR-0013 state: every ordinal 0, and
	 * every share resolved as the unrotated tie-break would have — which puts the
	 * odd satang on the same member every single time. Derived via `distributeEqually`
	 * at rotation 0 rather than hardcoded, so the fixture reflects the real rule
	 * (member ids are UUIDs; which one is "lowest" is not predictable from the test).
	 */
	async function rewindToLegacyRounding(txnIds: string[], memberIds: string[]) {
		const { transactions, transactionShares } = await import('$lib/server/db/transactions-schema');
		const legacy = distributeEqually(10_000, memberIds, 0);
		for (const txnId of txnIds) {
			await db.update(transactions).set({ roundingSeq: 0 }).where(eq(transactions.id, txnId));
			for (const row of legacy) {
				await db
					.update(transactionShares)
					.set({ amountOwed: row.amount })
					.where(
						and(
							eq(transactionShares.transactionId, txnId),
							eq(transactionShares.memberId, String(row.memberId))
						)
					);
			}
		}
		return legacy.find((r) => r.amount === 3334)!.memberId as string;
	}

	/** Which member owes the odd satang on each transaction, in the given order. */
	async function satangHolders(txnIds: string[]): Promise<string[]> {
		const { transactionShares } = await import('$lib/server/db/transactions-schema');
		const holders: string[] = [];
		for (const txnId of txnIds) {
			const rows = await db
				.select({
					memberId: transactionShares.memberId,
					amountOwed: transactionShares.amountOwed
				})
				.from(transactionShares)
				.where(eq(transactionShares.transactionId, txnId));
			expect(rows.reduce((sum, r) => sum + r.amountOwed, 0)).toBe(10_000);
			holders.push(rows.find((r) => r.amountOwed === 3334)!.memberId);
		}
		return holders;
	}

	async function auditRowCount(groupId: string, action: string): Promise<number> {
		const { auditLog } = await import('$lib/server/db/audit-schema');
		const rows = await db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(and(eq(auditLog.groupId, groupId), eq(auditLog.action, action)));
		return rows.length;
	}

	async function seedLegacyHistory() {
		const { group, memberIds } = await groupOfThree();
		const txnIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			txnIds.push(
				await createTransaction({
					userId: userA.id,
					groupId: group.id,
					settlementCurrency: 'THB',
					input: hundredBahtEqually(memberIds, memberIds[0], `Dinner ${i + 1}`)
				})
			);
		}
		const victim = await rewindToLegacyRounding(txnIds, memberIds);
		// The fixture really is the unfair state the backfill exists to correct.
		expect(await satangHolders(txnIds)).toEqual([victim, victim, victim]);
		return { group, memberIds, txnIds, victim };
	}

	// ── The point of the exercise ──────────────────────────────────────────────

	it('rotates a pre-ADR history so each member carries the odd satang once', async () => {
		const { group, memberIds, txnIds } = await seedLegacyHistory();

		await backfillRoundingRotation({ apply: true });
		await resyncGroupCounters();

		const holders = await satangHolders(txnIds);
		expect(new Set(holders).size).toBe(3);
		expect([...holders].sort()).toEqual([...memberIds].sort());

		// The ledger still balances — the rewrite moved satang BETWEEN members, it did
		// not create or destroy any.
		const balances = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(balances.reduce((sum, b) => sum + b.balance, 0)).toBe(0);
	});

	it('leaves an audit row per rewritten transaction (PLAN §12.1)', async () => {
		const { group } = await seedLegacyHistory();

		expect(await auditRowCount(group.id, 'recalculate')).toBe(0);
		await backfillRoundingRotation({ apply: true });
		// Two of the three transactions move (the one already at ordinal 0 does not).
		expect(await auditRowCount(group.id, 'recalculate')).toBe(2);
	});

	// ── Safety properties ──────────────────────────────────────────────────────

	it('preview mode reports the changes but writes nothing', async () => {
		const { group, txnIds, victim } = await seedLegacyHistory();

		const report = await backfillRoundingRotation({ apply: false });
		const groupReport = report.groups.find((g) => g.groupId === group.id)!;
		expect(groupReport.changed.length).toBe(2);

		// Not one row moved.
		expect(await satangHolders(txnIds)).toEqual([victim, victim, victim]);
		expect(await auditRowCount(group.id, 'recalculate')).toBe(0);
	});

	it('is idempotent — a second run changes nothing and writes no audit rows', async () => {
		const { group, txnIds } = await seedLegacyHistory();

		await backfillRoundingRotation({ apply: true });
		const afterFirst = await satangHolders(txnIds);
		const auditAfterFirst = await auditRowCount(group.id, 'recalculate');

		const second = await backfillRoundingRotation({ apply: true });
		expect(second.groups.find((g) => g.groupId === group.id)!.changed).toEqual([]);
		expect(await satangHolders(txnIds)).toEqual(afterFirst);
		expect(await auditRowCount(group.id, 'recalculate')).toBe(auditAfterFirst);
	});

	it('rewrites only resolved amounts — never the inputs or `updated_at`', async () => {
		const { group, memberIds } = await groupOfThree();
		const { transactions, transactionShares } = await import('$lib/server/db/transactions-schema');

		// A SHARE split with weights 1:1:1 — an all-tie distribution, so it rotates —
		// whose stored weights must survive the rewrite untouched.
		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'THB',
			input: {
				...hundredBahtEqually(memberIds, memberIds[0], 'Weighted'),
				splitMode: 'share' as const,
				beneficiaries: memberIds.map((memberId) => ({ memberId, shareWeight: 1 }))
			}
		});
		await db.update(transactions).set({ roundingSeq: 0 }).where(eq(transactions.id, txnId));

		const [before] = await db
			.select({ updatedAt: transactions.updatedAt })
			.from(transactions)
			.where(eq(transactions.id, txnId));

		await backfillRoundingRotation({ apply: true });

		const weights = await db
			.select({ shareWeight: transactionShares.shareWeight })
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txnId));
		expect(weights.map((w) => w.shareWeight)).toEqual([1, 1, 1]);

		const [after] = await db
			.select({ updatedAt: transactions.updatedAt })
			.from(transactions)
			.where(eq(transactions.id, txnId));
		// Nobody edited this transaction, so its edit timestamp must not move.
		expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
	});

	it('resyncs each group counter past the ordinals it just assigned', async () => {
		const { group, txnIds } = await seedLegacyHistory();
		const { groups } = await import('$lib/server/db/groups-schema');

		// Simulate a legacy group whose counter never advanced.
		await db.update(groups).set({ nextRoundingSeq: 0 }).where(eq(groups.id, group.id));

		await backfillRoundingRotation({ apply: true });
		await resyncGroupCounters();

		const [row] = await db
			.select({ next: groups.nextRoundingSeq })
			.from(groups)
			.where(eq(groups.id, group.id));
		// The next transaction continues the rotation rather than reusing an ordinal.
		expect(row.next).toBe(txnIds.length);
	});

	it('does not disturb transactions with nothing to rotate', async () => {
		// An `amount` split is a passthrough — no remainder exists, so no ordinal can
		// change it. It must come through the backfill byte-identical.
		const { group, memberIds } = await groupOfThree();
		const { transactionShares } = await import('$lib/server/db/transactions-schema');

		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'THB',
			input: {
				...hundredBahtEqually(memberIds, memberIds[0], 'Exact amounts'),
				splitMode: 'amount' as const,
				beneficiaries: [
					{ memberId: memberIds[0], rawAmount: 5000 },
					{ memberId: memberIds[1], rawAmount: 3000 },
					{ memberId: memberIds[2], rawAmount: 2000 }
				]
			}
		});

		const owedBefore = await db
			.select({ memberId: transactionShares.memberId, amountOwed: transactionShares.amountOwed })
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txnId));

		await backfillRoundingRotation({ apply: true });

		const owedAfter = await db
			.select({ memberId: transactionShares.memberId, amountOwed: transactionShares.amountOwed })
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txnId));
		expect(owedAfter).toEqual(owedBefore);
		expect(await auditRowCount(group.id, 'recalculate')).toBe(0);
	});

	it('scopes rotation per group — one group’s history does not renumber another’s', async () => {
		const first = await seedLegacyHistory();
		const second = await groupOfThree();
		const soloTxn = await createTransaction({
			userId: userA.id,
			groupId: second.group.id,
			settlementCurrency: 'THB',
			input: hundredBahtEqually(second.memberIds, second.memberIds[0], 'Only one')
		});

		await backfillRoundingRotation({ apply: true });

		const { transactions } = await import('$lib/server/db/transactions-schema');
		const [row] = await db
			.select({ roundingSeq: transactions.roundingSeq })
			.from(transactions)
			.where(eq(transactions.id, soloTxn));
		expect(row.roundingSeq).toBe(0);

		// And the first group really was renumbered.
		const firstRows = await db
			.select({ roundingSeq: transactions.roundingSeq })
			.from(transactions)
			.where(inArray(transactions.id, first.txnIds));
		expect(firstRows.map((r) => r.roundingSeq).sort()).toEqual([0, 1, 2]);
	});

	it('orders ordinals by the IMMUTABLE occurred_at, not the editable created_at', async () => {
		// `created_at` is the user-editable real-world date (§7.1). If ordinals were
		// derived from it, backdating any transaction would reshuffle every later
		// ordinal and move shares again on the next run — so the backfill must ignore it.
		const { group, txnIds } = await seedLegacyHistory();
		const { transactions } = await import('$lib/server/db/transactions-schema');

		// Backdate the LAST-inserted transaction to long before the others.
		await db
			.update(transactions)
			.set({ createdAt: new Date('2020-01-01T12:00:00.000Z') })
			.where(eq(transactions.id, txnIds[2]));

		await backfillRoundingRotation({ apply: true });

		const rows = await db
			.select({ id: transactions.id, roundingSeq: transactions.roundingSeq })
			.from(transactions)
			.where(eq(transactions.groupId, group.id));
		const byId = new Map(rows.map((r) => [r.id, r.roundingSeq]));
		// Insert order still decides: the backdated row keeps ordinal 2.
		expect(byId.get(txnIds[0])).toBe(0);
		expect(byId.get(txnIds[1])).toBe(1);
		expect(byId.get(txnIds[2])).toBe(2);

		// Belt and braces: re-running after the backdate still changes nothing.
		const second = await backfillRoundingRotation({ apply: true });
		expect(second.groups.find((g) => g.groupId === group.id)!.changed).toEqual([]);
	});

	it('keeps every itemized receipt summing to its total after the rewrite', async () => {
		const { group, memberIds } = await groupOfThree();
		const { transactions, transactionShares } = await import('$lib/server/db/transactions-schema');

		// Three ฿1.00 items each split three ways — every item leaves a leftover satang,
		// so the whole receipt is rotation-sensitive at both the item and aggregate level.
		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'THB',
			input: {
				type: 'spending' as const,
				title: 'Receipt',
				categoryId: SPENDING_CATEGORY,
				amountTotal: 300,
				currency: 'THB',
				exchangeRate: '1',
				amountTotalSettlement: 300,
				splitMode: 'itemized' as const,
				payers: [{ memberId: memberIds[0], amountPaid: 300 }],
				beneficiaries: [],
				items: [1, 2, 3].map((n) => ({
					label: `Item ${n}`,
					amount: 100,
					splitMode: 'equal' as const,
					beneficiaries: memberIds.map((memberId) => ({ memberId }))
				})),
				charges: []
			}
		});
		await db.update(transactions).set({ roundingSeq: 0 }).where(eq(transactions.id, txnId));

		await backfillRoundingRotation({ apply: true });

		const shares = await db
			.select({ amountOwed: transactionShares.amountOwed })
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txnId));
		expect(shares.reduce((sum, s) => sum + s.amountOwed, 0)).toBe(300);

		// Per-item rows were rewritten too, and each item still sums to its own amount.
		const perItem = await db.execute(sql`
			select i.id, sum(s.amount_owed)::int as total
			from transaction_items i
			join transaction_item_shares s on s.item_id = i.id
			where i.transaction_id = ${txnId}
			group by i.id
		`);
		for (const row of perItem.rows as { total: number }[]) {
			expect(row.total).toBe(100);
		}

		const balances = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(balances.reduce((sum, b) => sum + b.balance, 0)).toBe(0);
	});

	// ── Group-defined entry currencies (#63; PLAN §7.5.2, ADR-0014) ────────────
	//
	// A custom currency's code is OPAQUE (`cur_<uuid>`) and resolves nowhere but its
	// own group's `currencies` rows, so re-resolving one of its transactions needs
	// that row's exponent. Before #63 the backfill only knew the seeded 29 and threw
	// on the first custom-currency transaction it met; these tests are what that
	// change is worth.

	/** A group of three, plus its own 0-decimal `BEER` currency (PLAN §7.5.2). */
	async function groupOfThreeWithBeer() {
		const { group, memberIds } = await groupOfThree();
		const beer = await createCustomCurrency({
			userId: userA.id,
			groupId: group.id,
			input: { displayCode: 'BEER', name: 'Bottle of beer', symbol: '🍺', exponent: 0 }
		});
		return { group, memberIds, beer };
	}

	/** Five beers at ฿2.00 each — ฿10.00 in all — split equally three ways. */
	const BEERS = 5;
	const BEER_ROUND_SETTLEMENT = 1000;

	/**
	 * The numbers above are chosen so BOTH things this suite cares about are visible:
	 *
	 *   - it is ROTATION-SENSITIVE at the entry level. 5 beers over 3 members is
	 *     2/2/1, and which member draws the short straw is exactly what `rounding_seq`
	 *     decides — so the backfill has something to move.
	 *   - it PINS THE EXPONENT. At BEER's own exponent 0, 5 units at rate 2 convert to
	 *     5 × ฿2.00 = ฿10.00 = 1000 satang. At exponent 2 the same 5 minor units are
	 *     0.05 BEER and convert to 10 satang instead. So a round that still ties out to
	 *     1000 after the rewrite proves the backfill resolved BEER's row rather than
	 *     assuming a seeded exponent — an assumption that used to be a throw.
	 */
	function beerRound(beerCode: string, memberIds: string[], payerId: string, title: string) {
		return {
			type: 'spending' as const,
			title,
			categoryId: SPENDING_CATEGORY,
			amountTotal: BEERS,
			currency: beerCode,
			// The scale these minor units were parsed at — the write path re-checks it
			// against the locked row (#69), so it must be BEER's own exponent.
			currencyExponent: 0,
			exchangeRate: '2',
			amountTotalSettlement: BEER_ROUND_SETTLEMENT,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: BEERS }],
			beneficiaries: memberIds.map((memberId) => ({ memberId })),
			items: [],
			charges: []
		};
	}

	/** Every member's resolved SETTLEMENT `amount_owed` on one transaction. */
	async function owedByMember(txnId: string): Promise<Map<string, number>> {
		const { transactionShares } = await import('$lib/server/db/transactions-schema');
		const rows = await db
			.select({ memberId: transactionShares.memberId, amountOwed: transactionShares.amountOwed })
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txnId));
		return new Map(rows.map((r) => [r.memberId, r.amountOwed]));
	}

	/** Who drew the short straw — the member owing the least on this round. */
	async function shortStraw(txnId: string): Promise<string> {
		const owed = [...(await owedByMember(txnId))];
		expect(owed.reduce((sum, [, amount]) => sum + amount, 0)).toBe(BEER_ROUND_SETTLEMENT);
		return owed.reduce((low, entry) => (entry[1] < low[1] ? entry : low))[0];
	}

	/**
	 * Rewind BEER rounds to the pre-ADR-0013 state, the same way `rewindToLegacyRounding`
	 * does for the seeded case: ordinal 0 everywhere, and every share resolved as the
	 * UNROTATED tie-break would have — so the same member draws the short straw on
	 * every round. Derived through the real primitives rather than hardcoded, because
	 * which member is "lowest" depends on generated UUIDs.
	 */
	async function rewindBeerRounds(txnIds: string[], memberIds: string[]) {
		const { transactions, transactionShares } = await import('$lib/server/db/transactions-schema');
		const entry = distributeEqually(BEERS, memberIds, 0);
		const legacy = distributeToSettlement(
			entry.map((r) => ({ memberId: String(r.memberId), amount: r.amount })),
			BEER_ROUND_SETTLEMENT,
			0
		);
		for (const txnId of txnIds) {
			await db.update(transactions).set({ roundingSeq: 0 }).where(eq(transactions.id, txnId));
			for (const row of legacy) {
				await db
					.update(transactionShares)
					.set({ amountOwed: row.amountOwed })
					.where(
						and(
							eq(transactionShares.transactionId, txnId),
							eq(transactionShares.memberId, row.memberId)
						)
					);
			}
		}
	}

	it('re-resolves a history recorded in a group-defined currency', async () => {
		const { group, memberIds, beer } = await groupOfThreeWithBeer();

		const txnIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			txnIds.push(
				await createTransaction({
					userId: userA.id,
					groupId: group.id,
					settlementCurrency: 'THB',
					input: beerRound(beer.code, memberIds, memberIds[0], `Round ${i + 1}`)
				})
			);
		}
		await rewindBeerRounds(txnIds, memberIds);

		// The fixture really is the unfair state: one member short-changed every round.
		const before = [];
		for (const txnId of txnIds) before.push(await shortStraw(txnId));
		expect(new Set(before).size).toBe(1);

		// PREVIEW resolves the custom descriptor too — this is where the pre-#63 code
		// threw — and still writes nothing.
		const preview = await backfillRoundingRotation({ apply: false });
		expect(preview.groups.find((g) => g.groupId === group.id)!.changed.length).toBe(2);
		const afterPreview = [];
		for (const txnId of txnIds) afterPreview.push(await shortStraw(txnId));
		expect(afterPreview).toEqual(before);

		await backfillRoundingRotation({ apply: true });

		// Rotated: the short straw now goes round the table exactly once.
		const after = [];
		for (const txnId of txnIds) after.push(await shortStraw(txnId));
		expect(new Set(after).size).toBe(3);
		expect([...after].sort()).toEqual([...memberIds].sort());

		// And it TIES OUT — `shortStraw` asserts each round still sums to its ฿10.00
		// settlement total, which is only that number at BEER's exponent 0.
		const balances = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(balances.reduce((sum, b) => sum + b.balance, 0)).toBe(0);
		expect(await auditRowCount(group.id, 'recalculate')).toBe(2);
	});

	it('re-resolves each row at its OWN exponent when a group mixes currencies', async () => {
		// One seeded-currency round and one group-defined round in the SAME group. The
		// descriptor is looked up per transaction, so each must convert at its own
		// exponent — ฿100.00 for the THB row, ฿10.00 for the BEER row — while sharing
		// one ordinal sequence.
		const { group, memberIds, beer } = await groupOfThreeWithBeer();
		const { transactions } = await import('$lib/server/db/transactions-schema');

		const thbTxn = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'THB',
			input: hundredBahtEqually(memberIds, memberIds[0], 'Dinner')
		});
		const beerTxn = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'THB',
			input: beerRound(beer.code, memberIds, memberIds[0], 'Round')
		});
		await db
			.update(transactions)
			.set({ roundingSeq: 0 })
			.where(inArray(transactions.id, [thbTxn, beerTxn]));

		await backfillRoundingRotation({ apply: true });

		// One sequence across both currencies, in insert order.
		const rows = await db
			.select({
				id: transactions.id,
				roundingSeq: transactions.roundingSeq,
				amountTotalSettlement: transactions.amountTotalSettlement
			})
			.from(transactions)
			.where(eq(transactions.groupId, group.id));
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get(thbTxn)!.roundingSeq).toBe(0);
		expect(byId.get(beerTxn)!.roundingSeq).toBe(1);

		// Each row's shares still add up to that row's own settlement total, which the
		// backfill RECOMPUTES from the stored rate rather than trusting the column.
		const thbOwed = [...(await owedByMember(thbTxn)).values()];
		expect(thbOwed.reduce((a, b) => a + b, 0)).toBe(10_000);
		expect(byId.get(thbTxn)!.amountTotalSettlement).toBe(10_000);

		const beerOwed = [...(await owedByMember(beerTxn)).values()];
		expect(beerOwed.reduce((a, b) => a + b, 0)).toBe(BEER_ROUND_SETTLEMENT);
		expect(byId.get(beerTxn)!.amountTotalSettlement).toBe(BEER_ROUND_SETTLEMENT);

		// The payer's settlement side is distributed from the same total, so the group
		// still nets to zero across two different entry currencies.
		const balances = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(balances.reduce((sum, b) => sum + b.balance, 0)).toBe(0);
	});

	it('is idempotent over a group-defined currency', async () => {
		// The custom path re-derives the settlement total from the currency row on EVERY
		// run, so "nothing changed" has to survive that re-derivation — otherwise the
		// script would keep rewriting the same rows and appending audit noise.
		const { group, memberIds, beer } = await groupOfThreeWithBeer();

		const txnIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			txnIds.push(
				await createTransaction({
					userId: userA.id,
					groupId: group.id,
					settlementCurrency: 'THB',
					input: beerRound(beer.code, memberIds, memberIds[0], `Round ${i + 1}`)
				})
			);
		}
		await rewindBeerRounds(txnIds, memberIds);

		await backfillRoundingRotation({ apply: true });
		const afterFirst = [];
		for (const txnId of txnIds) afterFirst.push(await owedByMember(txnId));
		const auditAfterFirst = await auditRowCount(group.id, 'recalculate');

		const second = await backfillRoundingRotation({ apply: true });
		expect(second.groups.find((g) => g.groupId === group.id)!.changed).toEqual([]);
		const afterSecond = [];
		for (const txnId of txnIds) afterSecond.push(await owedByMember(txnId));
		expect(afterSecond).toEqual(afterFirst);
		expect(await auditRowCount(group.id, 'recalculate')).toBe(auditAfterFirst);
	});
});
