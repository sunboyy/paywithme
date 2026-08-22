// Real-DB integration tests — INVITE / ACCEPT (PLAN §6.2 — member-agnostic links).
//
// Exercises the ACTUAL Drizzle queries of the invite service against a LOCAL
// Postgres, proving the accept-flow guarantees the mocked unit tests couldn't:
//   - member-agnostic invite → accept(mode 'new') creates a new linked member;
//     B gains access.
//   - re-accept by the same user → `already_member` (the one-per-user-per-group
//     pre-check AND the partial-unique backstop hold — no 500 / no dup row).
//   - accept(mode 'existing') claims an UNLINKED slot (preserving its
//     display_name); a second 'existing' claim of the same slot by another user →
//     `slot_taken` (single-use per slot).
//   - revoked / expired invites preview `invalid` and accept `invalid`.
//   - listActiveInvites excludes revoked + expired links.
//   - accept(mode 'new') AUTO-SUFFIXES a display name an active member already holds
//     (ADR-0015), including under concurrent joins — where only a real database can
//     show that the unique index, not a pre-read, decides who gets which number.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createGroup, userHasGroupAccess } from '$lib/server/groups';
import { addMember } from '$lib/server/members';
import {
	createInvite,
	getInviteAcceptInfo,
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

	it("member-agnostic invite: preview valid → accept(B, 'new') links a new member → re-accept = already_member", async () => {
		const invite = await createInvite({ userId: userA.id, groupId });

		const preview = await getInvitePreview(invite.token);
		expect(preview.status).toBe('valid');
		if (preview.status === 'valid') expect(preview.groupName).toBe('Invites');

		// First accept (join as a NEW member): a NEW linked member for B, who then
		// has access.
		const first = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'new' }
		});
		expect(first.status).toBe('accepted');
		if (first.status === 'accepted') {
			const [row] = await db.select().from(members).where(eq(members.id, first.memberId));
			expect(row.userId).toBe(userB.id);
			expect(row.groupId).toBe(groupId);
			expect(row.displayName).toBe(userB.name);
		}
		expect(await userHasGroupAccess(userB.id, groupId)).toBe(true);

		// Second accept by the SAME user → already_member (pre-check + unique backstop),
		// no unique-violation crash and no duplicate member row.
		const second = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'new' }
		});
		expect(second.status).toBe('already_member');

		const bMembers = await db.select().from(members).where(eq(members.userId, userB.id));
		expect(bMembers).toHaveLength(1);
	});

	it("accept(mode 'existing') claims an unlinked slot (name preserved); a second 'existing' claim = slot_taken", async () => {
		const slot = await addMember({ userId: userA.id, groupId, displayName: 'Reserved Name' });

		const invite = await createInvite({ userId: userA.id, groupId });

		// The accept-info view lists the unlinked, active slot as claimable.
		const info = await getInviteAcceptInfo(invite.token);
		expect(info.status).toBe('valid');
		if (info.status === 'valid') {
			expect(info.claimableMembers.map((m) => m.id)).toContain(slot.id);
		}

		// C claims the slot: accepted, member now linked to C, display_name PRESERVED
		// (the conditional UPDATE never overwrites it).
		const accept = await acceptInvite({
			userId: userC.id,
			userName: userC.name,
			token: invite.token,
			selection: { mode: 'existing', memberId: slot.id }
		});
		expect(accept.status).toBe('accepted');
		if (accept.status === 'accepted') expect(accept.memberId).toBe(slot.id);

		const [claimed] = await db.select().from(members).where(eq(members.id, slot.id));
		expect(claimed.userId).toBe(userC.id);
		expect(claimed.displayName).toBe('Reserved Name');

		// A SECOND 'existing' claim of the SAME slot by another user → slot_taken.
		const second = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'existing', memberId: slot.id }
		});
		expect(second.status).toBe('slot_taken');

		// B did not get a member in this group.
		const bMembers = await db.select().from(members).where(eq(members.userId, userB.id));
		expect(bMembers.filter((m) => m.groupId === groupId)).toHaveLength(0);

		// The now-linked slot no longer appears as claimable.
		const after = await getInviteAcceptInfo(invite.token);
		if (after.status === 'valid') {
			expect(after.claimableMembers.map((m) => m.id)).not.toContain(slot.id);
		}
	});

	it("cross-group guard: accept(mode 'existing') with a foreign group's member id → slot_taken (member NOT hijacked, no membership leaked)", async () => {
		// G1: the group whose OPEN invite token U holds.
		const invite = await createInvite({ userId: userA.id, groupId });

		// G2: a SEPARATE group (created by B) containing an UNLINKED, ACTIVE member
		// `mForeign`. U is NOT a member of G2 and was never told its member ids.
		const g2 = await createGroup({
			userId: userB.id,
			userName: userB.name,
			name: 'Foreign Group',
			settlementCurrency: 'USD'
		});
		const mForeign = await addMember({
			userId: userB.id,
			groupId: g2.id,
			displayName: 'Foreign Slot'
		});
		expect(mForeign.groupId).toBe(g2.id);
		expect(mForeign.userId).toBeNull();

		// A FRESH user U (not in G1 or G2) accepts G1's invite but passes the FOREIGN
		// member id from G2. The conditional UPDATE's `group_id = invite.groupId`
		// clause matches 0 rows, so this is rejected — U cannot claim a slot in
		// another group via a G1 token.
		const userU = await createTestUser('u');
		const result = await acceptInvite({
			userId: userU.id,
			userName: userU.name,
			token: invite.token,
			selection: { mode: 'existing', memberId: mForeign.id }
		});
		expect(result.status).toBe('slot_taken');

		// `mForeign` is UNTOUCHED — still unlinked (not hijacked into U's account).
		const [foreignAfter] = await db.select().from(members).where(eq(members.id, mForeign.id));
		expect(foreignAfter.userId).toBeNull();
		expect(foreignAfter.groupId).toBe(g2.id);

		// U gained NO member row anywhere — not in G1 (the rejected accept created
		// nothing) and not in G2 (never had access).
		const uMembers = await db.select().from(members).where(eq(members.userId, userU.id));
		expect(uMembers).toHaveLength(0);
		expect(await userHasGroupAccess(userU.id, groupId)).toBe(false);
		expect(await userHasGroupAccess(userU.id, g2.id)).toBe(false);
	});

	it('revoked invite: preview invalid, accept invalid', async () => {
		const invite = await createInvite({ userId: userA.id, groupId });
		await revokeInvite({ userId: userA.id, groupId, inviteId: invite.id });

		expect((await getInvitePreview(invite.token)).status).toBe('invalid');
		const accept = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'new' }
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
				expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
				createdBy: userA.id
			})
			.returning();
		expect(row.token).toBe(token);

		expect((await getInvitePreview(token)).status).toBe('invalid');
		const accept = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token,
			selection: { mode: 'new' }
		});
		expect(accept.status).toBe('invalid');
	});

	it("accept(mode 'new') with a name an ACTIVE member already holds → auto-suffixed '… (2)', never refused (ADR-0015)", async () => {
		// A placeholder slot already carries B's account name — B did not choose that
		// collision, so the join must succeed under the next free number.
		await addMember({ userId: userA.id, groupId, displayName: userB.name });
		const invite = await createInvite({ userId: userA.id, groupId });

		const result = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'new' }
		});

		expect(result.status).toBe('accepted');
		if (result.status !== 'accepted') return;
		const [row] = await db.select().from(members).where(eq(members.id, result.memberId));
		expect(row.displayName).toBe(`${userB.name} (2)`);
		// The canonical key is written in step with it, so this member takes part in
		// the uniqueness index like any other.
		expect(row.normalizedDisplayName).toBe(`${userB.name} (2)`.toLowerCase());
		expect(row.userId).toBe(userB.id);
		expect(await userHasGroupAccess(userB.id, groupId)).toBe(true);

		// The name the joiner collided with is untouched — nobody was renamed.
		const groupMembers = await db.select().from(members).where(eq(members.groupId, groupId));
		expect(groupMembers.filter((m) => m.displayName === userB.name)).toHaveLength(1);

		// C, whose name collides with nothing, is unaffected: no suffix.
		const plain = await acceptInvite({
			userId: userC.id,
			userName: userC.name,
			token: invite.token,
			selection: { mode: 'new' }
		});
		expect(plain.status).toBe('accepted');
		if (plain.status === 'accepted') {
			const [cRow] = await db.select().from(members).where(eq(members.id, plain.memberId));
			expect(cRow.displayName).toBe(userC.name);
		}
	});

	it("accept(mode 'new'): a DEACTIVATED member holding the name does not burn it", async () => {
		// The uniqueness index is partial on `deactivated_at IS NULL` (§6.3 keeps a
		// departed member's name in the ledger forever), so a joiner may take the name
		// of someone who has left — no suffix.
		const gone = await addMember({ userId: userA.id, groupId, displayName: userB.name });
		await db.update(members).set({ deactivatedAt: new Date() }).where(eq(members.id, gone.id));

		const invite = await createInvite({ userId: userA.id, groupId });
		const result = await acceptInvite({
			userId: userB.id,
			userName: userB.name,
			token: invite.token,
			selection: { mode: 'new' }
		});

		expect(result.status).toBe('accepted');
		if (result.status !== 'accepted') return;
		const [row] = await db.select().from(members).where(eq(members.id, result.memberId));
		expect(row.displayName).toBe(userB.name);
	});

	it('three NEAR-SIMULTANEOUS joins under the same name each get a DISTINCT suffix (the unique index is the authority)', async () => {
		const invite = await createInvite({ userId: userA.id, groupId });
		const sharedName = `Nan-${Date.now().toString(36)}`;

		// Three different users accepting at once, all named the same — each opens its
		// own transaction, so Postgres itself serializes them on the name index. A
		// pre-read alone would hand two of them the same number.
		const results = await Promise.all(
			[userB, userC, await createTestUser('d')].map((u) =>
				acceptInvite({
					userId: u.id,
					userName: sharedName,
					token: invite.token,
					selection: { mode: 'new' }
				})
			)
		);

		expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
		const memberIds = results.flatMap((r) => (r.status === 'accepted' ? [r.memberId] : []));
		expect(new Set(memberIds).size).toBe(3);

		// Exactly the first three names of the family, one each — no duplicates, and no
		// number skipped (each joiner takes the lowest FREE one).
		const rows = await db
			.select()
			.from(members)
			.where(and(eq(members.groupId, groupId), isNull(members.deactivatedAt)));
		const joined = rows.filter((m) => memberIds.includes(m.id)).map((m) => m.displayName);
		expect(joined.sort()).toEqual([sharedName, `${sharedName} (2)`, `${sharedName} (3)`].sort());
		// …and every stored key matches its name, or the index would stop protecting it.
		for (const m of rows) {
			expect(m.normalizedDisplayName).toBe(m.displayName.trim().toLowerCase());
		}
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
