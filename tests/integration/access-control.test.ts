// Real-DB integration tests — ACCESS CONTROL (PLAN §12).
//
// The Phase-3 unit tests mocked `$lib/server/db`; this suite exercises the ACTUAL
// Drizzle/SQL queries of the group/member services against a LOCAL Postgres,
// proving the membership-based authorization the plan mandates: access is granted
// ONLY via an ACTIVE linked member in a NON-soft-deleted group, and is revoked by
// soft-deleting the group OR deactivating the linked member.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
	createGroup,
	softDeleteGroup,
	userHasGroupAccess,
	getGroupForUser,
	listGroupsForUser
} from '$lib/server/groups';
import { addMember, removeMember } from '$lib/server/members';
import { groups, members } from '$lib/server/db/groups-schema';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

describeIntegration('integration: access control (PLAN §12)', () => {
	let userA: { id: string; name: string };
	let userB: { id: string; name: string };

	beforeEach(async () => {
		userA = await createTestUser('a');
		userB = await createTestUser('b');
	});

	afterEach(async () => {
		await cleanupSuiteRows();
	});

	it('createGroup grants the creator access and lists it; a non-member has none', async () => {
		const group = await createGroup({
			userId: userA.id,
			userName: userA.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});

		// The creator-member row was written in the same transaction (PLAN §6.1).
		const memberRows = await db
			.select()
			.from(members)
			.where(and(eq(members.groupId, group.id), eq(members.userId, userA.id)));
		expect(memberRows).toHaveLength(1);
		expect(memberRows[0].displayName).toBe(userA.name);

		// A has access; it's in their list; getGroupForUser returns it.
		expect(await userHasGroupAccess(userA.id, group.id)).toBe(true);
		const list = await listGroupsForUser(userA.id);
		expect(list.map((g) => g.id)).toContain(group.id);
		expect(await getGroupForUser(userA.id, group.id)).not.toBeNull();

		// B (no membership) has no access, an empty list, and a null fetch.
		expect(await userHasGroupAccess(userB.id, group.id)).toBe(false);
		expect(await getGroupForUser(userB.id, group.id)).toBeNull();
		expect(await listGroupsForUser(userB.id)).toHaveLength(0);
	});

	it('softDeleteGroup revokes access but retains the row with deleted_at set', async () => {
		const group = await createGroup({
			userId: userA.id,
			userName: userA.name,
			name: 'Dinner',
			settlementCurrency: 'USD'
		});
		expect(await userHasGroupAccess(userA.id, group.id)).toBe(true);

		await softDeleteGroup({ userId: userA.id, groupId: group.id });

		// A loses access; getGroupForUser is null; the list no longer shows it.
		expect(await userHasGroupAccess(userA.id, group.id)).toBe(false);
		expect(await getGroupForUser(userA.id, group.id)).toBeNull();
		expect((await listGroupsForUser(userA.id)).map((g) => g.id)).not.toContain(group.id);

		// The row is STILL present with deleted_at populated (soft delete, §6.4).
		const [row] = await db.select().from(groups).where(eq(groups.id, group.id));
		expect(row).toBeDefined();
		expect(row.deletedAt).not.toBeNull();
	});

	it('deactivating a linked member revokes that user’s access (soft-remove path)', async () => {
		// A creates a group, then B is given a member slot and links to it directly
		// (simulating a claimed invite — we set user_id on a fresh slot).
		const group = await createGroup({
			userId: userA.id,
			userName: userA.name,
			name: 'Flat',
			settlementCurrency: 'USD'
		});
		const slot = await addMember({ userId: userA.id, groupId: group.id, displayName: 'Bee' });
		await db.update(members).set({ userId: userB.id }).where(eq(members.id, slot.id));
		expect(await userHasGroupAccess(userB.id, group.id)).toBe(true);

		// Drive the SOFT path of removeMember via its injectable activity check.
		const result = await removeMember(
			{ userId: userA.id, groupId: group.id, memberId: slot.id },
			async () => true
		);
		expect(result.action).toBe('soft_deactivate');

		// The member row is still present (ledger intact) with deactivated_at set,
		// and B has lost access because the access primitive filters deactivated.
		const [row] = await db.select().from(members).where(eq(members.id, slot.id));
		expect(row).toBeDefined();
		expect(row.deactivatedAt).not.toBeNull();
		expect(await userHasGroupAccess(userB.id, group.id)).toBe(false);

		// A (creator, still active) keeps access.
		expect(await userHasGroupAccess(userA.id, group.id)).toBe(true);
	});
});
