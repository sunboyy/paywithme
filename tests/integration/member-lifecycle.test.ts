// Real-DB integration tests — MEMBER LIFECYCLE (PLAN §6.3).
//
// Exercises the ACTUAL Drizzle queries of the member service against a LOCAL
// Postgres: add (unlinked), rename, the soft-vs-hard removal branches driven by
// the injectable `hasActivity` seam, and reactivation. Also proves the REAL-DB
// fact that the partial unique index from task 3.1 allows MULTIPLE unlinked
// members (`user_id IS NULL`) in one group — something a mocked DB can't verify.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import {
	addMember,
	renameMember,
	removeMember,
	reactivateMember,
	listMembers
} from '$lib/server/members';
import { members } from '$lib/server/db/groups-schema';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

describeIntegration('integration: member lifecycle (PLAN §6.3)', () => {
	let userA: { id: string; name: string };
	let groupId: string;

	beforeEach(async () => {
		userA = await createTestUser('a');
		const group = await createGroup({
			userId: userA.id,
			userName: userA.name,
			name: 'Lifecycle',
			settlementCurrency: 'USD'
		});
		groupId = group.id;
	});

	afterEach(async () => {
		await cleanupSuiteRows();
	});

	it('addMember creates an unlinked slot that appears in listMembers', async () => {
		const m = await addMember({ userId: userA.id, groupId, displayName: 'Guest' });
		expect(m.userId).toBeNull();

		const list = await listMembers({ userId: userA.id, groupId });
		const found = list.find((x) => x.id === m.id);
		expect(found).toBeDefined();
		expect(found?.displayName).toBe('Guest');
		expect(found?.isLinked).toBe(false);
		expect(found?.deactivatedAt).toBeNull();
	});

	it('renameMember updates the display name', async () => {
		const m = await addMember({ userId: userA.id, groupId, displayName: 'Old' });
		const updated = await renameMember({
			userId: userA.id,
			groupId,
			memberId: m.id,
			displayName: 'New'
		});
		expect(updated.displayName).toBe('New');

		const [row] = await db.select().from(members).where(eq(members.id, m.id));
		expect(row.displayName).toBe('New');
	});

	it('removeMember HARD-deletes a zero-activity slot (hasActivity=false)', async () => {
		const m = await addMember({ userId: userA.id, groupId, displayName: 'Mistake' });

		const result = await removeMember(
			{ userId: userA.id, groupId, memberId: m.id },
			async () => false
		);
		expect(result.action).toBe('hard_delete');

		// Physically gone from the DB.
		const rows = await db.select().from(members).where(eq(members.id, m.id));
		expect(rows).toHaveLength(0);
	});

	it('removeMember SOFT-deactivates an active slot (hasActivity=true), reactivate clears it', async () => {
		const m = await addMember({ userId: userA.id, groupId, displayName: 'Keep' });

		const result = await removeMember(
			{ userId: userA.id, groupId, memberId: m.id },
			async () => true
		);
		expect(result.action).toBe('soft_deactivate');

		// Still present, deactivated_at set.
		const [deactivated] = await db.select().from(members).where(eq(members.id, m.id));
		expect(deactivated).toBeDefined();
		expect(deactivated.deactivatedAt).not.toBeNull();

		// Reactivate clears the flag.
		const reactivated = await reactivateMember({ userId: userA.id, groupId, memberId: m.id });
		expect(reactivated.deactivatedAt).toBeNull();

		const [row] = await db.select().from(members).where(eq(members.id, m.id));
		expect(row.deactivatedAt).toBeNull();
	});

	it('the partial unique index allows MULTIPLE unlinked members in one group', async () => {
		// Two addMember calls with user_id null both succeed — the REAL-DB proof that
		// the partial predicate `WHERE user_id IS NOT NULL` (task 3.1) does NOT
		// collapse unlinked slots. A plain composite unique would reject the second.
		const m1 = await addMember({ userId: userA.id, groupId, displayName: 'Unlinked 1' });
		const m2 = await addMember({ userId: userA.id, groupId, displayName: 'Unlinked 2' });
		expect(m1.id).not.toBe(m2.id);
		expect(m1.userId).toBeNull();
		expect(m2.userId).toBeNull();

		const unlinked = (await db.select().from(members).where(eq(members.groupId, groupId))).filter(
			(r) => r.userId == null
		);
		// Both unlinked slots persisted (plus the creator, who is linked — excluded).
		expect(unlinked.map((r) => r.id).sort()).toEqual([m1.id, m2.id].sort());
	});
});
