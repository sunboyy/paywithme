// Real-DB integration tests — SETTLEMENT LIFECYCLE (plan 003; PLAN §9).
//
// Proves the core money lifecycle end-to-end against a LOCAL Postgres, driving
// the SAME service functions the app calls and asserting against the real
// schema (never a mock). It complements the isolated unit tests
// (`src/lib/transactions/balances.test.ts`, `src/lib/server/transactions.test.ts`)
// and the UI e2e (`e2e/group-flow.spec.ts`) by asserting EXACT integer
// minor-unit balances against Postgres. Two invariants that matter:
//
//   1. SETTLE NETS TO ZERO. After a member pays for a shared spend, the group's
//      balances are correct (debtor negative / creditor positive, Σ = 0),
//      `suggestSettlements` proposes exactly the one transfer that clears it, and
//      after recording that transfer EVERY member's balance is exactly 0 with no
//      further suggestions.
//
//   2. SOFT-DELETE IS EXCLUDED. A soft-deleted transaction no longer contributes
//      to balances (PLAN §9; `getGroupBalances` filters `deleted_at IS NULL`), so
//      deleting the only spend returns every balance to 0.
//
// Cleanup relies on the documented cascades: `cleanupSuiteRows()` deletes this
// suite's groups, and `transactions.group_id` is `onDelete: 'cascade'`, so every
// transaction + audit row this suite creates is removed with its group. The
// suite-prefixed users go last. A second consecutive run is therefore green.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import { createTransaction, softDeleteTransaction } from '$lib/server/transactions';
import { getGroupBalances } from '$lib/server/balances';
import { suggestSettlements } from '$lib/transactions/balances';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

/** A spending category id that exists in the seeded set (task 4.3). */
const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

describeIntegration('integration: settlement lifecycle (plan 003; PLAN §9)', () => {
	let userA: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
	});

	afterEach(async () => {
		// Deleting our groups CASCADES our transaction + audit rows away
		// (group_id onDelete: cascade); the suite-prefixed users go last.
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

	/** A VALID transfer: a single debtor pays a single creditor the full amount. */
	function transferInput(fromMemberId: string, toMemberId: string, amount: number) {
		return {
			type: 'transfer' as const,
			title: 'Settle up',
			categoryId: 'transfer-debt-settlement',
			amountTotal: amount,
			currency: 'USD',
			exchangeRate: '1',
			amountTotalSettlement: amount,
			splitMode: 'equal' as const,
			payers: [{ memberId: fromMemberId, amountPaid: amount }],
			beneficiaries: [{ memberId: toMemberId }], // single beneficiary owes the full amount
			items: [],
			charges: []
		};
	}

	/** Create a fresh group owned by userA (USD settlement). */
	async function freshGroup(name = 'Settle') {
		return createGroup({
			userId: userA.id,
			userName: userA.name,
			name,
			settlementCurrency: 'USD'
		});
	}

	/** The creator's active member id in a group (for payer/beneficiary input). */
	async function creatorMemberId(groupId: string): Promise<string> {
		const { members } = await import('$lib/server/db/groups-schema');
		const [row] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, groupId), eq(members.userId, userA.id)));
		return row.id;
	}

	// ── 1. Full settle lifecycle: create → balances → settle → zero ──────────────

	it('records the suggested transfer and nets every balance to exactly zero', async () => {
		const group = await freshGroup('Settle');
		const bob = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Bob' });
		const aliceId = await creatorMemberId(group.id);

		// Alice pays 9000 for an equal split between Alice and Bob.
		await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([aliceId, bob.id], aliceId)
		});

		// Balances: Alice paid 9000, owes 4500 → +4500; Bob paid 0, owes 4500 → −4500.
		const balances = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(balances).toHaveLength(2);
		expect(balances.reduce((sum, b) => sum + b.balance, 0)).toBe(0);
		const alice = balances.find((b) => b.memberId === aliceId);
		const bobBal = balances.find((b) => b.memberId === bob.id);
		expect(alice?.balance).toBe(4500);
		expect(bobBal?.balance).toBe(-4500);

		// Exactly one suggestion: Bob → Alice, 4500.
		const suggestions = suggestSettlements(balances);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toEqual({
			fromMemberId: bob.id,
			toMemberId: aliceId,
			amount: 4500
		});

		// Record that suggested transfer.
		await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: transferInput(bob.id, aliceId, 4500)
		});

		// Every balance is now exactly 0; nothing left to settle.
		const newBalances = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(newBalances).toHaveLength(2);
		for (const b of newBalances) {
			expect(b.balance).toBe(0);
		}
		expect(suggestSettlements(newBalances)).toEqual([]);
	});

	// ── 2. Soft-deleted transactions are excluded from balances (PLAN §9) ────────

	it('excludes a soft-deleted transaction from balances', async () => {
		const group = await freshGroup('Settle');
		const bob = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Bob' });
		const aliceId = await creatorMemberId(group.id);

		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([aliceId, bob.id], aliceId)
		});

		// Pre-delete: balances are non-zero (Alice +4500 / Bob −4500).
		const before = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(before.find((b) => b.memberId === aliceId)?.balance).toBe(4500);
		expect(before.find((b) => b.memberId === bob.id)?.balance).toBe(-4500);

		await softDeleteTransaction({ userId: userA.id, groupId: group.id, txnId });

		// Post-delete: the deleted txn no longer contributes → every balance is 0.
		const after = await getGroupBalances({ userId: userA.id, groupId: group.id });
		expect(after).toHaveLength(2);
		for (const b of after) {
			expect(b.balance).toBe(0);
		}
		expect(suggestSettlements(after)).toEqual([]);
	});
});
