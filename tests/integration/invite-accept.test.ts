// Real-DB integration tests — INVITE / ACCEPT (PLAN §6.2).
//
// Exercises the ACTUAL Drizzle queries of the invite service against a LOCAL
// Postgres, proving the accept-flow guarantees the mocked unit tests couldn't:
//   - open invite → accept creates a new linked member; B gains access.
//   - re-accept by the same user → `already_member` (the one-per-user-per-group
//     pre-check AND the partial-unique backstop hold — no 500 / no dup row).
//   - member-targeted invite is SINGLE-USE: the first accept claims the slot
//     (preserving its display_name); a second accept by another user → `slot_taken`.
//   - revoked / expired invites preview `invalid` and accept `invalid`.
//   - listActiveInvites excludes revoked + expired links.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createGroup, userHasGroupAccess } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import {
	createInvite,
	getInvitePreview,
	acceptInvite,
	revokeInvite,
	listActiveInvites
} from '$lib/server/invites';
import { invites, members } from '$lib/server/db/groups-schema';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

describeIntegration('integration: invite / accept (PLAN §6.2)', () => {
	let userA: { id: string; name: string };
	let userB: { id: string; name: string };
	let userC: { id: string; name: string };
	let groupId: string;

	beforeEach(async () => {
		userA = await createTestUser('a');
		userB = await createTestUser('b');
		userC = await createTestUser('c');
		const group = await createGroup({
			userId: userA.id,
			userName: userA.name,
			name: 'Invites',
			settlementCurrency: 'USD'
		});
		groupId = group.id;
	});

	afterEach(async () => {
		await cleanupSuiteRows();
	});

	it('open invite: preview valid → accept(B) links a new member → re-accept = already_member', async () => {
		const invite = await createInvite({ userId: userA.id, groupId });

		const preview = await getInvitePreview(invite.token);
		expect(preview.status).toBe('valid');
		if (preview.status === 'valid') expect(preview.groupName).toBe('Invites');

		// First accept: a NEW linked member for B, who then has access.
		const first = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token
		});
		expect(first.status).toBe('accepted');
		if (first.status === 'accepted') {
			const [row] = await db.select().from(members).where(eq(members.id, first.memberId));
			expect(row.userId).toBe(userB.id);
			expect(row.groupId).toBe(groupId);
		}
		expect(await userHasGroupAccess(userB.id, groupId)).toBe(true);

		// Second accept by the SAME user → already_member (pre-check + unique backstop),
		// no unique-violation crash and no duplicate member row.
		const second = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token
		});
		expect(second.status).toBe('already_member');

		const bMembers = await db.select().from(members).where(eq(members.userId, userB.id));
		expect(bMembers).toHaveLength(1);
	});

	it('member-targeted invite is single-use: claims the slot (name preserved), second accept = slot_taken', async () => {
		const slot = await addMember({ userId: userA.id, groupId, displayName: 'Reserved Name' });
		const invite = await createInvite({ userId: userA.id, groupId, memberId: slot.id });

		// C claims the targeted slot: accepted, member now linked to C, display_name
		// PRESERVED (the conditional UPDATE never overwrites it).
		const accept = await acceptInvite({
			userId: userC.id,
			userName: userC.name,
			token: invite.token
		});
		expect(accept.status).toBe('accepted');
		if (accept.status === 'accepted') expect(accept.memberId).toBe(slot.id);

		const [claimed] = await db.select().from(members).where(eq(members.id, slot.id));
		expect(claimed.userId).toBe(userC.id);
		expect(claimed.displayName).toBe('Reserved Name');

		// A SECOND accept by another user finds the slot filled → slot_taken (single-use).
		const second = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token
		});
		expect(second.status).toBe('slot_taken');

		// B did not get a member in this group.
		const bMembers = await db.select().from(members).where(eq(members.userId, userB.id));
		expect(bMembers.filter((m) => m.groupId === groupId)).toHaveLength(0);
	});

	it('revoked invite: preview invalid, accept invalid', async () => {
		const invite = await createInvite({ userId: userA.id, groupId });
		await revokeInvite({ userId: userA.id, groupId, inviteId: invite.id });

		expect((await getInvitePreview(invite.token)).status).toBe('invalid');
		const accept = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token
		});
		expect(accept.status).toBe('invalid');
	});

	it('expired invite: preview invalid, accept invalid', async () => {
		// Insert directly with a past expires_at — the service never mints expired
		// invites, so we craft one to exercise the expiry guard.
		const token = `${'it39-expired-'}${Date.now().toString(36)}`;
		const [row] = await db
			.insert(invites)
			.values({
				groupId,
				token,
				memberId: null,
				expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
				createdBy: userA.id
			})
			.returning();
		expect(row.token).toBe(token);

		expect((await getInvitePreview(token)).status).toBe('invalid');
		const accept = await acceptInvite({ userId: userB.id, userName: userB.name, token });
		expect(accept.status).toBe('invalid');
	});

	it('listActiveInvites excludes revoked and expired links', async () => {
		const active = await createInvite({ userId: userA.id, groupId });
		const revoked = await createInvite({ userId: userA.id, groupId });
		await revokeInvite({ userId: userA.id, groupId, inviteId: revoked.id });

		// An expired one inserted directly.
		const expiredToken = `${'it39-expired2-'}${Date.now().toString(36)}`;
		await db.insert(invites).values({
			groupId,
			token: expiredToken,
			memberId: null,
			expiresAt: new Date(Date.now() - 60_000),
			createdBy: userA.id
		});

		const list = await listActiveInvites({ userId: userA.id, groupId });
		const ids = list.map((i) => i.id);
		expect(ids).toContain(active.id);
		expect(ids).not.toContain(revoked.id);
		expect(list.some((i) => i.token === expiredToken)).toBe(false);
	});
});
