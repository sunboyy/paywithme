// Real-DB integration tests — ROUNDING ROTATION (ADR-0013; PLAN §7.2).
//
// The unit tests prove the ROTATION MATHS (`money.test.ts`, `resolve.test.ts`) and
// the service tests prove the WIRING against a mock (`transactions.test.ts`). What
// only a real Postgres can prove is the piece those cannot: that the ordinal
// allocation
//
//     UPDATE groups SET next_rounding_seq = next_rounding_seq + 1 ... RETURNING
//
// actually increments, actually returns its POST-increment value, and actually
// serialises under concurrency. A mock returning a canned number would pass even
// if that statement were wrong, so the user-visible promise — "three ฿100 splits
// three ways charge each member the extra satang once" — is asserted here against
// the real schema, end to end through `createTransaction`.
//
// Cleanup relies on the documented cascades (see `settlement.test.ts`):
// `cleanupSuiteRows()` deletes this suite's groups and `transactions.group_id` is
// `onDelete: 'cascade'`, so every row created here goes with them.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import { createTransaction, updateTransaction } from '$lib/server/transactions';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

describeIntegration('integration: rounding rotation (ADR-0013; PLAN §7.2)', () => {
	let userA: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
	});

	afterEach(async () => {
		await cleanupSuiteRows();
	});

	/**
	 * ฿100.00 (10 000 satang) split equally between the given members. 10 000 / 3 is
	 * 3 333 remainder 1, so exactly one member owes 3 334 — the case the ADR exists
	 * for. THB is 2-dp, matching the original report.
	 */
	function hundredBahtEqually(memberIds: string[], payerId: string, title = 'Dinner') {
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

	async function freshGroupOfThree() {
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

	/** The member owing the odd satang (3 334) on a given transaction. */
	async function extraSatangHolder(txnId: string): Promise<string> {
		const { transactionShares } = await import('$lib/server/db/transactions-schema');
		const rows = await db
			.select({ memberId: transactionShares.memberId, amountOwed: transactionShares.amountOwed })
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txnId));
		expect(rows.map((r) => r.amountOwed).sort()).toEqual([3333, 3333, 3334]);
		return rows.find((r) => r.amountOwed === 3334)!.memberId;
	}

	// ── THE REQUIREMENT ────────────────────────────────────────────────────────

	it('three ฿100 three-way splits charge each member the extra satang exactly once', async () => {
		const { group, memberIds } = await freshGroupOfThree();

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

		const holders = [];
		for (const id of txnIds) holders.push(await extraSatangHolder(id));

		// Every member carried it exactly once — no member is systematically out of
		// pocket, which is the whole point (before ADR-0013 this was [x, x, x]).
		expect(new Set(holders).size).toBe(3);
		expect([...holders].sort()).toEqual([...memberIds].sort());
	});

	it('allocates a distinct, increasing ordinal per transaction and advances the group counter', async () => {
		const { group, memberIds } = await freshGroupOfThree();
		const { transactions } = await import('$lib/server/db/transactions-schema');
		const { groups } = await import('$lib/server/db/groups-schema');

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

		const rows = await db
			.select({ id: transactions.id, roundingSeq: transactions.roundingSeq })
			.from(transactions)
			.where(inArray(transactions.id, txnIds));
		const seqs = rows.map((r) => r.roundingSeq).sort((a, b) => a - b);
		expect(seqs).toEqual([0, 1, 2]);

		// The counter is left pointing at the NEXT free ordinal.
		const [groupRow] = await db
			.select({ next: groups.nextRoundingSeq })
			.from(groups)
			.where(eq(groups.id, group.id));
		expect(groupRow.next).toBe(3);
	});

	it('counts ordinals per GROUP, so one group does not consume another’s rotation', async () => {
		const first = await freshGroupOfThree();
		const second = await freshGroupOfThree();

		await createTransaction({
			userId: userA.id,
			groupId: first.group.id,
			settlementCurrency: 'THB',
			input: hundredBahtEqually(first.memberIds, first.memberIds[0])
		});
		const otherTxn = await createTransaction({
			userId: userA.id,
			groupId: second.group.id,
			settlementCurrency: 'THB',
			input: hundredBahtEqually(second.memberIds, second.memberIds[0])
		});

		const { transactions } = await import('$lib/server/db/transactions-schema');
		const [row] = await db
			.select({ roundingSeq: transactions.roundingSeq })
			.from(transactions)
			.where(eq(transactions.id, otherTxn));
		// The second group's FIRST transaction starts its own rotation at 0.
		expect(row.roundingSeq).toBe(0);
	});

	it('concurrent creates in one group never share an ordinal', async () => {
		// The allocation takes a row lock inside each transaction, so simultaneous
		// writes serialise on it. A read-then-write would hand out duplicates here.
		const { group, memberIds } = await freshGroupOfThree();

		const txnIds = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				createTransaction({
					userId: userA.id,
					groupId: group.id,
					settlementCurrency: 'THB',
					input: hundredBahtEqually(memberIds, memberIds[0], `Concurrent ${i + 1}`)
				})
			)
		);

		const { transactions } = await import('$lib/server/db/transactions-schema');
		const rows = await db
			.select({ roundingSeq: transactions.roundingSeq })
			.from(transactions)
			.where(inArray(transactions.id, txnIds));
		const seqs = rows.map((r) => r.roundingSeq).sort((a, b) => a - b);
		expect(seqs).toEqual([0, 1, 2, 3, 4]);
	});

	// ── Editing must not re-roll the rounding ──────────────────────────────────

	it('editing an unrelated field leaves the odd satang exactly where it was', async () => {
		// The reason the ordinal is STORED rather than derived: re-resolving at a fresh
		// ordinal would move a member's balance on a title correction.
		const { group, memberIds } = await freshGroupOfThree();

		// Two transactions, so the one we edit is NOT sitting at ordinal 0 — editing a
		// seq-0 transaction would pass even if the code re-allocated from a fresh group.
		await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'THB',
			input: hundredBahtEqually(memberIds, memberIds[0], 'First')
		});
		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'THB',
			input: hundredBahtEqually(memberIds, memberIds[0], 'Second')
		});

		const before = await extraSatangHolder(txnId);

		await updateTransaction({
			userId: userA.id,
			groupId: group.id,
			txnId,
			settlementCurrency: 'THB',
			input: hundredBahtEqually(memberIds, memberIds[0], 'Second (corrected)')
		});

		expect(await extraSatangHolder(txnId)).toBe(before);

		// And the edit did not consume an ordinal from the group counter.
		const { groups } = await import('$lib/server/db/groups-schema');
		const [groupRow] = await db
			.select({ next: groups.nextRoundingSeq })
			.from(groups)
			.where(eq(groups.id, group.id));
		expect(groupRow.next).toBe(2);
	});
});
