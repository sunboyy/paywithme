// Real-DB integration tests — the "relates to this member" list filter (PLAN §10).
//
// The unit tests can only prove the SHAPE of the predicate
// (`src/lib/server/transactions-member-filter.test.ts` renders it through
// `PgDialect`). Only Postgres can prove what it MEANS against real payer/share
// rows, and three of those meanings are exactly where a naive implementation
// breaks:
//
//   1. NO FAN-OUT. A member who BOTH paid and owes on the same transaction must
//      yield ONE row. A join against `transaction_shares` (rather than the
//      correlated EXISTS) would emit one row per beneficiary — silently breaking
//      the caller's `limit` and the §16.4 keyset order.
//   2. A ZERO SHARE STILL COUNTS. Involvement is row presence, not a non-zero
//      amount: a beneficiary the split resolved to 0 was still named on the
//      receipt.
//   3. A FOREIGN MEMBER ID MATCHES NOTHING. A real member id from ANOTHER group
//      returns an empty list rather than an error or a leak.
//
// Cleanup relies on the documented cascades (see `settlement.test.ts`):
// `cleanupSuiteRows()` deletes this suite's groups and `transactions.group_id` is
// `onDelete: 'cascade'`, so every transaction + child row goes with it.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import {
	createTransaction,
	listTransactions,
	encodeTransactionCursor
} from '$lib/server/transactions';
import { members } from '$lib/server/db/groups-schema';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

const SPENDING_CATEGORY = categoriesFor('spending')[0].id;
const TRANSFER_CATEGORY = 'transfer-debt-settlement';

describeIntegration('integration: transaction member filter (PLAN §10)', () => {
	let owner: { id: string; name: string };

	beforeEach(async () => {
		owner = await createTestUser('owner');
	});

	afterEach(async () => {
		await cleanupSuiteRows();
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	async function freshGroup(name = 'Filter') {
		return createGroup({
			userId: owner.id,
			userName: owner.name,
			name,
			settlementCurrency: 'USD'
		});
	}

	/** The creator's own member id in a group. */
	async function creatorMemberId(groupId: string): Promise<string> {
		const [row] = await db
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, groupId), eq(members.userId, owner.id)));
		return row.id;
	}

	/**
	 * An equal-split spending txn: `payerId` pays 1000, split equally between
	 * `beneficiaryIds`. `date` pins the §7.1 real-world date so the newest-first
	 * order in every assertion below is deterministic.
	 */
	function equalSpending(
		payerId: string,
		beneficiaryIds: string[],
		title: string,
		date: string,
		type: 'spending' | 'transfer' = 'spending'
	) {
		return {
			type,
			title,
			categoryId: type === 'spending' ? SPENDING_CATEGORY : TRANSFER_CATEGORY,
			date,
			amountTotal: 1000,
			currency: 'USD',
			exchangeRate: '1',
			amountTotalSettlement: 1000,
			splitMode: 'equal' as const,
			payers: [{ memberId: payerId, amountPaid: 1000 }],
			beneficiaries: beneficiaryIds.map((memberId) => ({ memberId })),
			items: [],
			charges: []
		};
	}

	/**
	 * An AMOUNT-split spending txn — the only way to author a beneficiary whose
	 * resolved share is exactly 0 (used for invariant 2 above).
	 */
	function amountSpending(
		payerId: string,
		lines: { memberId: string; rawAmount: number }[],
		title: string,
		date: string
	) {
		const total = lines.reduce((sum, l) => sum + l.rawAmount, 0);
		return {
			type: 'spending' as const,
			title,
			categoryId: SPENDING_CATEGORY,
			date,
			amountTotal: total,
			currency: 'USD',
			exchangeRate: '1',
			amountTotalSettlement: total,
			splitMode: 'amount' as const,
			payers: [{ memberId: payerId, amountPaid: total }],
			beneficiaries: lines,
			items: [],
			charges: []
		};
	}

	/**
	 * The fixture group: members A (the creator), B, C, and four transactions —
	 *
	 *   T1  A paid,  A + B owe        ← A is on BOTH sides (the fan-out trap)
	 *   T2  B paid,  B + C owe        ← A is on neither side
	 *   T3  A paid,  B + C owe        ← A paid only
	 *   T4  C paid,  A owes 0, B owes ← A is a beneficiary with a ZERO share
	 *
	 * Dates ascend T1→T4, so newest-first is [T4, T3, T2, T1].
	 */
	async function fixture() {
		const group = await freshGroup();
		const a = await creatorMemberId(group.id);
		const b = await addMember({ userId: owner.id, groupId: group.id, displayName: 'Bee' });
		const c = await addMember({ userId: owner.id, groupId: group.id, displayName: 'Cee' });

		const mk = async (input: ReturnType<typeof equalSpending>) =>
			createTransaction({
				userId: owner.id,
				groupId: group.id,
				settlementCurrency: 'USD',
				input
			});

		await mk(equalSpending(a, [a, b.id], 'T1', '2026-01-01'));
		await mk(equalSpending(b.id, [b.id, c.id], 'T2', '2026-01-02'));
		// A transfer, so the member filter can be combined with the type filter.
		await mk(equalSpending(a, [b.id, c.id], 'T3', '2026-01-03', 'transfer'));
		await createTransaction({
			userId: owner.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: amountSpending(
				c.id,
				[
					{ memberId: a, rawAmount: 0 },
					{ memberId: b.id, rawAmount: 1000 }
				],
				'T4',
				'2026-01-04'
			)
		});

		// Transactions are identified by TITLE in the assertions below (T1…T4) — the
		// ids are never needed, and the titles make a failing expectation readable.
		return { group, a, b, c };
	}

	/** Run the list with a member filter and return the matching titles, newest first. */
	async function titles(
		groupId: string,
		filters: Parameters<typeof listTransactions>[0]['filters']
	) {
		const rows = await listTransactions({ userId: owner.id, groupId, filters });
		return rows.map((r) => r.title);
	}

	// ── 1. Either side (the "relates to me" default) ────────────────────────────

	it('matches transactions the member paid for OR benefited from, exactly once each', async () => {
		const { group, a } = await fixture();

		const rows = await listTransactions({
			userId: owner.id,
			groupId: group.id,
			filters: { memberId: a }
		});

		// T1 (paid + owes), T3 (paid), T4 (owes 0) — but NOT T2.
		expect(rows.map((r) => r.title)).toEqual(['T4', 'T3', 'T1']);
		// NO FAN-OUT: T1 has A as both payer and beneficiary and still appears once.
		expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
	});

	it('excludes a member with no involvement at all', async () => {
		const { group, a, b, c } = await fixture();
		// Every member is involved somewhere, so use a member of the SAME group who
		// was added after the fact and never appears on a transaction.
		const dee = await addMember({ userId: owner.id, groupId: group.id, displayName: 'Dee' });
		expect(await titles(group.id, { memberId: dee.id })).toEqual([]);
		// Sanity: the other three are all involved.
		for (const m of [a, b.id, c.id]) {
			expect((await titles(group.id, { memberId: m })).length).toBeGreaterThan(0);
		}
	});

	// ── 2. Role narrowing: paid / owes ──────────────────────────────────────────

	it("role 'paid' returns only the transactions the member actually paid for", async () => {
		const { group, a } = await fixture();
		expect(await titles(group.id, { memberId: a, memberRole: 'paid' })).toEqual(['T3', 'T1']);
	});

	it("role 'owes' returns only the transactions the member benefited from — including a ZERO share", async () => {
		const { group, a } = await fixture();
		// T4 is the point: A's resolved share there is exactly 0, and involvement is
		// row PRESENCE, not a non-zero amount.
		expect(await titles(group.id, { memberId: a, memberRole: 'owes' })).toEqual(['T4', 'T1']);
	});

	it('the two roles partition nothing away — their union is the unfiltered member set', async () => {
		const { group, a } = await fixture();
		const paid = await titles(group.id, { memberId: a, memberRole: 'paid' });
		const owes = await titles(group.id, { memberId: a, memberRole: 'owes' });
		const either = await titles(group.id, { memberId: a });
		expect(new Set(either)).toEqual(new Set([...paid, ...owes]));
	});

	// ── 3. A foreign / unknown member id matches nothing (no error, no leak) ─────

	it('returns an empty list for a real member id belonging to ANOTHER group', async () => {
		const { group } = await fixture();
		const other = await freshGroup('Other');
		const stranger = await addMember({
			userId: owner.id,
			groupId: other.id,
			displayName: 'Stranger'
		});
		await expect(titles(group.id, { memberId: stranger.id })).resolves.toEqual([]);
	});

	it('returns an empty list for an id that does not exist at all', async () => {
		const { group } = await fixture();
		await expect(titles(group.id, { memberId: 'no-such-member' })).resolves.toEqual([]);
	});

	it('ignores a role given without a member id', async () => {
		const { group } = await fixture();
		// All four transactions — the bare role is a no-op, not a filter.
		expect(await titles(group.id, { memberRole: 'paid' })).toEqual(['T4', 'T3', 'T2', 'T1']);
	});

	// ── 4. Composition with the other filters + §16.4 pagination ────────────────

	it('composes with the type filter', async () => {
		const { group, a } = await fixture();
		// A is involved in T1/T3/T4; only T3 is a transfer.
		expect(await titles(group.id, { memberId: a, type: 'transfer' })).toEqual(['T3']);
		expect(await titles(group.id, { memberId: a, type: 'spending' })).toEqual(['T4', 'T1']);
	});

	it('composes with the date range', async () => {
		const { group, a } = await fixture();
		const rows = await titles(group.id, {
			memberId: a,
			from: new Date('2026-01-02T00:00:00.000Z'),
			to: new Date('2026-01-03T23:59:59.999Z')
		});
		expect(rows).toEqual(['T3']);
	});

	it('pages with the §16.4 keyset cursor over the FILTERED set', async () => {
		const { group, a } = await fixture();

		const [first] = await listTransactions({
			userId: owner.id,
			groupId: group.id,
			filters: { memberId: a },
			limit: 1
		});
		expect(first.title).toBe('T4');

		// The cursor is minted from the row's full sort key and is filter-independent;
		// re-applying the SAME filter must continue through the MATCHING rows only —
		// never resurface T2, which the filter excludes.
		const next = await listTransactions({
			userId: owner.id,
			groupId: group.id,
			filters: {
				memberId: a,
				after: encodeTransactionCursor({
					createdAt: new Date(first.createdAt),
					occurredAt: new Date(first.occurredAt),
					id: first.id
				})
			}
		});
		expect(next.map((r) => r.title)).toEqual(['T3', 'T1']);
	});
});
