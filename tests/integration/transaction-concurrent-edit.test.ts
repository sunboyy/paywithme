// Real-DB integration tests — CONCURRENT EDITS of one transaction (issue #94).
//
// An edit deletes every child row and inserts freshly resolved ones. Without a lock
// on the transaction row, two edits under READ COMMITTED each delete only the rows
// they saw and both insert, so a split between A+B edited at once to C+D can keep
// all four shares: `Σ amount_owed ≠ amount_total_settlement`, silently. Only a real
// Postgres can show that, so these race two `updateTransaction` calls for real.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import { createTransaction, updateTransaction } from '$lib/server/transactions';
import { categoriesFor } from '$lib/categories';
import { members } from '$lib/server/db/groups-schema';
import { transactionShares, transactions } from '$lib/server/db/transactions-schema';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;
const ROUNDS = 10;

describeIntegration('integration: concurrent edits of one transaction (#94)', () => {
	let user: { id: string; name: string };

	beforeEach(async () => {
		user = await createTestUser('edit');
	});

	afterEach(async () => {
		await cleanupSuiteRows();
	});

	async function groupOfFour() {
		const group = await createGroup({
			userId: user.id,
			userName: user.name,
			name: 'Trip',
			settlementCurrency: 'THB'
		});
		const [creator] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, group.id), eq(members.userId, user.id)));
		const others = [];
		for (const displayName of ['Bob', 'Cam', 'Dee']) {
			others.push((await addMember({ userId: user.id, groupId: group.id, displayName })).id);
		}
		return { groupId: group.id, ids: [creator.id, ...others] };
	}

	function equalSplit(payerId: string, beneficiaryIds: string[]) {
		return {
			type: 'spending' as const,
			title: 'Dinner',
			categoryId: SPENDING_CATEGORY,
			amountTotal: 10_000,
			currency: 'THB',
			exchangeRate: '1',
			amountTotalSettlement: 10_000,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: 10_000 }],
			beneficiaries: beneficiaryIds.map((memberId) => ({ memberId })),
			items: [],
			charges: []
		};
	}

	/** Race two edits of one transaction; one may fail, neither may corrupt it. */
	async function raceEdits(groupId: string, txnId: string, inputs: [unknown, unknown]) {
		await Promise.allSettled(
			inputs.map((input) =>
				updateTransaction({ userId: user.id, groupId, txnId, input, settlementCurrency: 'THB' })
			)
		);
	}

	async function owedTotal(txnId: string): Promise<number> {
		const [row] = await db
			.select({ total: sql<number>`coalesce(sum(${transactionShares.amountOwed}), 0)::int` })
			.from(transactionShares)
			.where(eq(transactionShares.transactionId, txnId));
		return row.total;
	}

	it('disjoint re-splits never leave shares that disagree with the total', async () => {
		const { groupId, ids } = await groupOfFour();
		const [a, b, c, d] = ids;

		for (let round = 0; round < ROUNDS; round++) {
			const { id: txnId } = await createTransaction({
				userId: user.id,
				groupId,
				input: equalSplit(a, [a, b]),
				settlementCurrency: 'THB'
			});

			await raceEdits(groupId, txnId, [equalSplit(a, [a, b]), equalSplit(a, [c, d])]);

			const [txn] = await db
				.select({ total: transactions.amountTotalSettlement })
				.from(transactions)
				.where(eq(transactions.id, txnId));
			expect(await owedTotal(txnId)).toBe(txn.total);
		}
	});
});
