// Real-DB integration tests — MEMBER REMOVAL vs LEDGER ACTIVITY (plan 007;
// PLAN §6.3).
//
// Proves `removeMember`'s real activity check (`memberHasActivity` in
// `$lib/server/members`) against the real schema, not a mock. `members.id` is
// referenced with `ON DELETE CASCADE` from `transaction_payers` and
// `transaction_shares`, so a member with ANY ledger activity must be
// soft-deactivated — never hard-deleted, or their rows (and every other
// member's balance) would silently vanish. A member with zero activity is
// still the intended hard-delete cleanup path (a mistyped slot).
//
// Cleanup relies on the same documented cascades `settlement.test.ts` uses:
// `cleanupSuiteRows()` deletes this suite's groups, and `transactions.group_id`
// is `onDelete: 'cascade'`, so every transaction/payer/share/audit row this
// suite creates is removed with its group. The suite-prefixed users go last.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { addMember, removeMember } from '$lib/server/members';
import { createTransaction } from '$lib/server/transactions';
import { members } from '$lib/server/db/groups-schema';
import { transactionPayers, transactionShares } from '$lib/server/db/transactions-schema';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

/** A spending category id that exists in the seeded set (task 4.3). */
const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

describeIntegration('integration: member removal vs ledger activity (plan 007; PLAN §6.3)', () => {
	let userA: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
	});

	afterEach(async () => {
		// Deleting our groups CASCADES our transaction + payer/share + audit rows
		// away (group_id onDelete: cascade); the suite-prefixed users go last.
		await cleanupSuiteRows();
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	/** A minimal VALID equal-split spending transaction (one payer, all beneficiaries). */
	function equalSpendingInput(memberIds: string[], payerId: string, title = 'Dinner') {
		return {
			type: 'spending' as const,
			title,
			categoryId: SPENDING_CATEGORY,
			amountTotal: 9000,
			currency: 'USD',
			exchangeRate: '1',
			amountTotalSettlement: 9000,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: 9000 }],
			beneficiaries: memberIds.map((memberId) => ({ memberId })),
			items: [],
			charges: []
		};
	}

	/** Create a fresh group owned by userA (USD settlement). */
	async function freshGroup(name = 'Removal') {
		return createGroup({
			userId: userA.id,
			userName: userA.name,
			name,
			settlementCurrency: 'USD'
		});
	}

	/** The creator's active member id in a group (for payer/beneficiary input). */
	async function creatorMemberId(groupId: string): Promise<string> {
		const [row] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, groupId), eq(members.userId, userA.id)));
		return row.id;
	}

	// ── 1. A member with a share row survives removal ────────────────────────────

	it('soft-deactivates a member who was only a beneficiary, keeping their share rows', async () => {
		const group = await freshGroup('Beneficiary');
		const bob = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Bob' });
		const aliceId = await creatorMemberId(group.id);

		// Alice pays; Bob is only a beneficiary (a share row, no payer row).
		await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([aliceId, bob.id], aliceId)
		});

		const result = await removeMember({ userId: userA.id, groupId: group.id, memberId: bob.id });
		expect(result).toEqual({ action: 'soft_deactivate' });

		const [row] = await db.select().from(members).where(eq(members.id, bob.id));
		expect(row).toBeDefined();
		expect(row.deactivatedAt).not.toBeNull();

		const shareRows = await db
			.select()
			.from(transactionShares)
			.where(eq(transactionShares.memberId, bob.id));
		expect(shareRows.length).toBeGreaterThan(0);
	});

	// ── 2. A member who only paid survives removal (the regression that matters) ─

	it('soft-deactivates a member who was only a payer, keeping their payer rows', async () => {
		const group = await freshGroup('Payer');
		const bob = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Bob' });
		const aliceId = await creatorMemberId(group.id);

		// Bob pays; both are beneficiaries (Bob has both a payer row and a share
		// row here, but the key regression is the payer row surviving removal —
		// before this fix, ON DELETE CASCADE silently wiped it).
		await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([aliceId, bob.id], bob.id)
		});

		const result = await removeMember({ userId: userA.id, groupId: group.id, memberId: bob.id });
		expect(result).toEqual({ action: 'soft_deactivate' });

		const payerRows = await db
			.select()
			.from(transactionPayers)
			.where(eq(transactionPayers.memberId, bob.id));
		expect(payerRows.length).toBeGreaterThan(0);
	});

	// ── 3. A never-used slot is still hard-deleted (cleanup path preserved) ──────

	it('hard-deletes a member with zero ledger activity', async () => {
		const group = await freshGroup('Unused');
		await addMember({ userId: userA.id, groupId: group.id, displayName: 'Bob' });
		const aliceId = await creatorMemberId(group.id);
		const carol = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Carol' });

		// Only Alice is referenced by the transaction; Carol has no ledger activity.
		await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([aliceId], aliceId)
		});

		const result = await removeMember({ userId: userA.id, groupId: group.id, memberId: carol.id });
		expect(result).toEqual({ action: 'hard_delete' });

		const rows = await db.select().from(members).where(eq(members.id, carol.id));
		expect(rows).toHaveLength(0);
	});
});
