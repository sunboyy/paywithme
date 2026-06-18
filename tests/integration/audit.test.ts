// Real-DB integration tests — AUDIT TRAIL (task 6.4; PLAN §12.1).
//
// Proves the audit trail end-to-end against a LOCAL Postgres, driving the SAME
// service functions the app calls and asserting against the real `audit_log`
// table (never a mock). Two contracts (§12.1):
//
//   1. ONE entry per mutation. Every audited mutation writes EXACTLY ONE new
//      `audit_log` row — asserted as a row-count DELTA (before vs after), with the
//      correct action / entity_type / entity_id / actor_user_id / group_id, a
//      non-empty server-composed `summary`, and a server-stamped `occurred_at`.
//      Covers the full audited set (group / member / invite / transaction) plus the
//      two NEGATIVE cases: the zero-activity removeMember HARD-DELETE writes NO row
//      (task 6.1 decision), and a FAILED mutation (access denied) rolls the audit
//      write back (same-transaction guarantee).
//
//   2. APPEND-ONLY, survives soft-delete. After soft-deleting a transaction (and,
//      separately, a group), the earlier `create` entry AND the `delete` entry are
//      STILL present and UNCHANGED — the trail outlives the soft-deleted entity
//      (§12.1). Group soft-delete does NOT hard-delete the group, so the
//      group_id-cascade never fires and the rows persist.
//
// Cleanup relies on the documented cascades: `cleanupSuiteRows()` deletes this
// suite's groups, and BOTH `audit_log.group_id` and `transactions.group_id` are
// `onDelete: 'cascade'` (see audit-schema.ts / transactions-schema.ts), so every
// audit + transaction row this suite creates is removed with its group. No extra
// scoped deletes are needed (a second consecutive run is green).

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
	createGroup,
	renameGroup,
	updateSettlementCurrency,
	softDeleteGroup,
	GroupAccessError
} from '$lib/server/groups';
import { addMember, renameMember, removeMember, reactivateMember } from '$lib/server/members';
import { createInvite, revokeInvite, acceptInvite } from '$lib/server/invites';
import {
	createTransaction,
	updateTransaction,
	softDeleteTransaction,
	restoreTransaction
} from '$lib/server/transactions';
import { listGroupActivity, listEntityActivity } from '$lib/server/activity';
import { auditLog } from '$lib/server/db/audit-schema';
import { groups } from '$lib/server/db/groups-schema';
import { categoriesFor } from '$lib/categories';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

/** A spending category id that exists in the seeded set (task 4.3). */
const SPENDING_CATEGORY = categoriesFor('spending')[0].id;

describeIntegration('integration: audit trail (task 6.4; PLAN §12.1)', () => {
	let userA: { id: string; name: string };
	let userB: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
		userB = await createTestUser('b');
	});

	afterEach(async () => {
		// Deleting our groups CASCADES our audit_log + transaction rows away
		// (group_id onDelete: cascade); the suite-prefixed users go last. A re-run
		// therefore leaves no `it39-` residue.
		await cleanupSuiteRows();
	});

	// ── helpers ────────────────────────────────────────────────────────────────

	/** Count this group's audit rows (the delta basis for "exactly one new row"). */
	async function auditCount(groupId: string): Promise<number> {
		const rows = await db.select().from(auditLog).where(eq(auditLog.groupId, groupId));
		return rows.length;
	}

	/** The single audit row for (group, entity_type, entity_id, action). */
	async function auditRow(groupId: string, entityType: string, entityId: string, action: string) {
		const rows = await db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.groupId, groupId),
					eq(auditLog.entityType, entityType),
					eq(auditLog.entityId, entityId),
					eq(auditLog.action, action)
				)
			);
		return rows;
	}

	/**
	 * Run a mutation and assert it wrote EXACTLY ONE new audit row for the group,
	 * matching the expected action / entity / actor, with a non-empty summary and a
	 * server-stamped occurred_at. Returns the new row for any extra assertions.
	 */
	async function expectOneAuditRow<T>(
		groupId: string,
		expected: { action: string; entityType: string; entityId: string; actorUserId: string },
		mutation: () => Promise<T>
	): Promise<{ result: T }> {
		const before = await auditCount(groupId);
		const result = await mutation();
		const after = await auditCount(groupId);
		// EXACTLY ONE new row (count the delta — not just "≥1").
		expect(after - before).toBe(1);

		const matches = await auditRow(
			groupId,
			expected.entityType,
			expected.entityId,
			expected.action
		);
		expect(matches).toHaveLength(1);
		const row = matches[0];
		expect(row.groupId).toBe(groupId);
		expect(row.actorUserId).toBe(expected.actorUserId);
		expect(row.action).toBe(expected.action);
		expect(row.entityType).toBe(expected.entityType);
		expect(row.entityId).toBe(expected.entityId);
		// Server-composed, durable, non-empty.
		expect(typeof row.summary).toBe('string');
		expect(row.summary.length).toBeGreaterThan(0);
		// Server-stamped immutable insert time / sort key.
		expect(row.occurredAt).toBeInstanceOf(Date);
		return { result };
	}

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

	/** Create a fresh group owned by userA (its create audit row is written too). */
	async function freshGroup(name = 'Audit') {
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

	// ── 1. GROUP mutations — one entry each ──────────────────────────────────────

	it('group create / rename / currency_set / delete each write exactly one audit row', async () => {
		// create — count from zero (the row is written in the createGroup tx).
		const beforeAnything = (await db.select().from(auditLog)).length;
		const group = await createGroup({
			userId: userA.id,
			userName: userA.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		const afterCreate = (await db.select().from(auditLog)).length;
		expect(afterCreate - beforeAnything).toBe(1);
		const created = await auditRow(group.id, 'group', group.id, 'create');
		expect(created).toHaveLength(1);
		expect(created[0].actorUserId).toBe(userA.id);
		expect(created[0].summary.length).toBeGreaterThan(0);

		// rename
		await expectOneAuditRow(
			group.id,
			{ action: 'rename', entityType: 'group', entityId: group.id, actorUserId: userA.id },
			() => renameGroup({ userId: userA.id, groupId: group.id, name: 'Trip 2' })
		);

		// currency_set (allowed while the group has no transactions)
		await expectOneAuditRow(
			group.id,
			{ action: 'currency_set', entityType: 'group', entityId: group.id, actorUserId: userA.id },
			() =>
				updateSettlementCurrency({ userId: userA.id, groupId: group.id, settlementCurrency: 'EUR' })
		);

		// delete (soft-delete)
		await expectOneAuditRow(
			group.id,
			{ action: 'delete', entityType: 'group', entityId: group.id, actorUserId: userA.id },
			() => softDeleteGroup({ userId: userA.id, groupId: group.id })
		);
	});

	// ── 2. MEMBER mutations — one entry each ─────────────────────────────────────

	it('member add / rename / deactivate / reactivate each write exactly one audit row', async () => {
		const group = await freshGroup();

		// add — the member id is only known after the call, so assert the delta + row
		// directly (rather than via the entityId-keyed helper).
		const before = await auditCount(group.id);
		const member = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Guest' });
		const after = await auditCount(group.id);
		expect(after - before).toBe(1);
		expect(member.id).toBeTruthy();
		const addRows = await auditRow(group.id, 'member', member.id, 'add');
		expect(addRows).toHaveLength(1);
		expect(addRows[0].actorUserId).toBe(userA.id);
		expect(addRows[0].summary.length).toBeGreaterThan(0);
		expect(addRows[0].occurredAt).toBeInstanceOf(Date);

		// rename
		await expectOneAuditRow(
			group.id,
			{ action: 'rename', entityType: 'member', entityId: member.id, actorUserId: userA.id },
			() =>
				renameMember({
					userId: userA.id,
					groupId: group.id,
					memberId: member.id,
					displayName: 'Renamed'
				})
		);

		// deactivate — force the SOFT path via the injectable activity check.
		await expectOneAuditRow(
			group.id,
			{ action: 'deactivate', entityType: 'member', entityId: member.id, actorUserId: userA.id },
			() =>
				removeMember({ userId: userA.id, groupId: group.id, memberId: member.id }, async () => true)
		);

		// reactivate
		await expectOneAuditRow(
			group.id,
			{ action: 'reactivate', entityType: 'member', entityId: member.id, actorUserId: userA.id },
			() => reactivateMember({ userId: userA.id, groupId: group.id, memberId: member.id })
		);
	});

	it('removeMember HARD-delete (zero activity) writes NO audit row (task 6.1 decision)', async () => {
		const group = await freshGroup();
		const member = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Mistake' });

		const before = await auditCount(group.id);
		const result = await removeMember(
			{ userId: userA.id, groupId: group.id, memberId: member.id },
			async () => false // zero activity → hard delete
		);
		expect(result.action).toBe('hard_delete');
		const after = await auditCount(group.id);
		// No new audit row for the hard-delete branch.
		expect(after).toBe(before);
		// And no member-delete row exists for this member at all.
		const anyForMember = await db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.entityType, 'member'),
					eq(auditLog.entityId, member.id),
					eq(auditLog.action, 'delete')
				)
			);
		expect(anyForMember).toHaveLength(0);
	});

	// ── 3. INVITE mutations — one entry each, incl. accept→member add ────────────

	it('invite create / revoke each write exactly one audit row', async () => {
		const group = await freshGroup();

		// invite id is only known after the call; assert the delta + row directly.
		const before = await auditCount(group.id);
		const invite = await createInvite({ userId: userA.id, groupId: group.id });
		const after = await auditCount(group.id);
		expect(after - before).toBe(1);
		const createRows = await auditRow(group.id, 'invite', invite.id, 'create');
		expect(createRows).toHaveLength(1);
		expect(createRows[0].actorUserId).toBe(userA.id);
		expect(createRows[0].summary.length).toBeGreaterThan(0);
		// Token MUST NOT leak into the audit trail (it is the capability secret).
		expect(createRows[0].summary).not.toContain(invite.token);

		await expectOneAuditRow(
			group.id,
			{ action: 'revoke', entityType: 'invite', entityId: invite.id, actorUserId: userA.id },
			() => revokeInvite({ userId: userA.id, groupId: group.id, inviteId: invite.id })
		);
	});

	it("invite accept (join-as-new) writes one member 'add' row, actor = accepting user", async () => {
		const group = await freshGroup();
		const invite = await createInvite({ userId: userA.id, groupId: group.id });

		const before = await auditCount(group.id);
		const result = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'new' }
		});
		const after = await auditCount(group.id);
		expect(after - before).toBe(1);
		expect(result.status).toBe('accepted');
		if (result.status === 'accepted') {
			const rows = await auditRow(group.id, 'member', result.memberId, 'add');
			expect(rows).toHaveLength(1);
			// Actor is the ACCEPTING user (durable authorship), not the inviter.
			expect(rows[0].actorUserId).toBe(userB.id);
			expect(rows[0].summary).not.toContain(invite.token);
		}
	});

	it("invite accept (claim existing slot) writes one member 'add' row for the claimed slot", async () => {
		const group = await freshGroup();
		const slot = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Reserved' });
		const invite = await createInvite({ userId: userA.id, groupId: group.id });

		const before = await auditCount(group.id);
		const result = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'existing', memberId: slot.id }
		});
		const after = await auditCount(group.id);
		expect(after - before).toBe(1);
		expect(result.status).toBe('accepted');
		if (result.status === 'accepted') {
			expect(result.memberId).toBe(slot.id);
			// Two 'add' rows now exist for this member id: the original addMember (by
			// userA) AND the accept-claim (by userB) — both are legitimate adds. The
			// accept wrote EXACTLY ONE new row (asserted via the delta above); confirm
			// the NEW one is authored by the accepting user (durable authorship).
			const rows = await auditRow(group.id, 'member', slot.id, 'add');
			expect(rows.length).toBeGreaterThanOrEqual(1);
			const byB = rows.filter((r) => r.actorUserId === userB.id);
			expect(byB).toHaveLength(1);
			expect(byB[0].summary.length).toBeGreaterThan(0);
		}
	});

	// ── 4. TRANSACTION mutations — one entry each ────────────────────────────────

	it('transaction create / edit / delete / restore each write exactly one audit row', async () => {
		const group = await freshGroup();
		const memberId = await creatorMemberId(group.id);

		// create
		const before = await auditCount(group.id);
		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([memberId], memberId)
		});
		const afterCreate = await auditCount(group.id);
		expect(afterCreate - before).toBe(1);
		const createRows = await auditRow(group.id, 'transaction', txnId, 'create');
		expect(createRows).toHaveLength(1);
		expect(createRows[0].actorUserId).toBe(userA.id);
		expect(createRows[0].summary.length).toBeGreaterThan(0);

		// edit
		await expectOneAuditRow(
			group.id,
			{ action: 'edit', entityType: 'transaction', entityId: txnId, actorUserId: userA.id },
			() =>
				updateTransaction({
					userId: userA.id,
					groupId: group.id,
					txnId,
					settlementCurrency: 'USD',
					input: equalSpendingInput([memberId], memberId, 'Dinner (edited)')
				})
		);

		// delete (soft-delete)
		await expectOneAuditRow(
			group.id,
			{ action: 'delete', entityType: 'transaction', entityId: txnId, actorUserId: userA.id },
			() => softDeleteTransaction({ userId: userA.id, groupId: group.id, txnId })
		);

		// restore
		await expectOneAuditRow(
			group.id,
			{ action: 'restore', entityType: 'transaction', entityId: txnId, actorUserId: userA.id },
			() => restoreTransaction({ userId: userA.id, groupId: group.id, txnId })
		);
	});

	// ── 5. NEGATIVE: a failed mutation writes NO row (same-tx rollback) ──────────

	it('a FAILED mutation (access denied) writes NO audit row — same-transaction rollback', async () => {
		const group = await freshGroup();
		const before = await auditCount(group.id);

		// userB is NOT a member → renameGroup throws GroupAccessError, rolling back
		// any audit write that would have joined the same transaction.
		await expect(
			renameGroup({ userId: userB.id, groupId: group.id, name: 'Hijacked' })
		).rejects.toBeInstanceOf(GroupAccessError);

		const after = await auditCount(group.id);
		expect(after).toBe(before);
		// Specifically, no 'rename' row was written.
		expect(await auditRow(group.id, 'group', group.id, 'rename')).toHaveLength(0);
	});

	// ── 6. APPEND-ONLY: trail survives soft-delete (transaction + group) ─────────

	it('transaction soft-delete: the create AND delete audit entries SURVIVE, unchanged', async () => {
		const group = await freshGroup();
		const memberId = await creatorMemberId(group.id);
		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([memberId], memberId)
		});

		// Snapshot the create row BEFORE the soft-delete.
		const [createBefore] = await auditRow(group.id, 'transaction', txnId, 'create');
		expect(createBefore).toBeDefined();

		await softDeleteTransaction({ userId: userA.id, groupId: group.id, txnId });

		// The create entry is STILL present and BYTE-identical (append-only, never edited).
		const [createAfter] = await auditRow(group.id, 'transaction', txnId, 'create');
		expect(createAfter).toBeDefined();
		expect(createAfter.id).toBe(createBefore.id);
		expect(createAfter.summary).toBe(createBefore.summary);
		expect(createAfter.occurredAt.getTime()).toBe(createBefore.occurredAt.getTime());

		// And the delete entry exists alongside it (the trail outlives the soft-delete).
		expect(await auditRow(group.id, 'transaction', txnId, 'delete')).toHaveLength(1);
	});

	it('group soft-delete: group create + delete audit entries SURVIVE (no cascade fires)', async () => {
		const group = await freshGroup();
		const [createBefore] = await auditRow(group.id, 'group', group.id, 'create');
		expect(createBefore).toBeDefined();

		await softDeleteGroup({ userId: userA.id, groupId: group.id });

		// The group row is NOT hard-deleted (deleted_at set), so the group_id-cascade
		// never fires — both the create and delete audit rows persist.
		const [groupRow] = await db.select().from(groups).where(eq(groups.id, group.id));
		expect(groupRow.deletedAt).not.toBeNull();

		const [createAfter] = await auditRow(group.id, 'group', group.id, 'create');
		expect(createAfter).toBeDefined();
		expect(createAfter.id).toBe(createBefore.id);
		expect(createAfter.summary).toBe(createBefore.summary);
		expect(await auditRow(group.id, 'group', group.id, 'delete')).toHaveLength(1);
	});

	// ── 7. (nice-to-have) the feeds surface these entries newest-first ───────────

	it('listGroupActivity / listEntityActivity surface entries newest-first end-to-end', async () => {
		const group = await freshGroup();
		const memberId = await creatorMemberId(group.id);
		const txnId = await createTransaction({
			userId: userA.id,
			groupId: group.id,
			settlementCurrency: 'USD',
			input: equalSpendingInput([memberId], memberId)
		});
		await softDeleteTransaction({ userId: userA.id, groupId: group.id, txnId });

		// Group feed: newest-first by occurred_at — the most recent entry is the delete.
		const feed = await listGroupActivity({ userId: userA.id, groupId: group.id });
		expect(feed.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < feed.length; i++) {
			expect(new Date(feed[i - 1].occurredAt).getTime()).toBeGreaterThanOrEqual(
				new Date(feed[i].occurredAt).getTime()
			);
		}

		// Entity feed for the txn: both its own entries (create + delete), newest-first.
		const entityFeed = await listEntityActivity({
			userId: userA.id,
			groupId: group.id,
			entityType: 'transaction',
			entityId: txnId
		});
		const actions = entityFeed.map((e) => e.action);
		expect(actions).toContain('create');
		expect(actions).toContain('delete');
		// delete (most recent) comes before create.
		expect(actions.indexOf('delete')).toBeLessThan(actions.indexOf('create'));
	});
});
