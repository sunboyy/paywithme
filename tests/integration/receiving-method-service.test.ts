// Real-DB integration tests — the RECEIVING-METHOD SERVICE (issue #84;
// PLAN §17.1, §17.3, §17.5; §6.3; ADR-0016).
//
// The visibility rule is the security-critical part of this feature and it is
// entirely a SQL predicate over `members` / `groups`: "visible to any member of
// any group they share", derived on every read and never stored. A mocked DB can
// only replay what it was told, so the rule is pinned HERE, against a real
// Postgres — including the two asymmetries that fall out of PLAN §6.3:
//
//   - the VIEWER's own member row must be ACTIVE (deactivation removes that
//     user's access to the group entirely);
//   - the TARGET may be DEACTIVATED and is still payable (deactivation does not
//     clear outstanding balances, and the settle screen still shows what a
//     departed member is owed).
//
// Also proved here, for the same reason: the `max(position) + 1` append, the
// single-transaction reorder, the hard delete, the cross-user NOT-FOUND answers,
// and that NOT ONE mutation writes an `audit_log` row (ADR-0016 — the deliberate
// exception to CLAUDE.md's every-mutation rule; if this fails, read the ADR
// before "fixing" it).
//
// The unit spec (`src/lib/server/receiving-methods.test.ts`) covers the registry
// gate and the error model without a database.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createGroup } from '$lib/server/groups';
import { groups, members } from '$lib/server/db/groups-schema';
import { auditLog } from '$lib/server/db/audit-schema';
import { receivingMethod } from '$lib/server/db/receiving-schema';
import { displayNameValues } from '$lib/server/member-name';
import {
	listOwn,
	listForViewer,
	create,
	update,
	remove,
	reorder,
	InvalidReceivingMethodError,
	ReceivingMethodNotFoundError,
	ReceivingMethodOrderMismatchError
} from '$lib/server/receiving-methods';
import { createTestUser, cleanupSuiteRows, db, describeIntegration } from './helpers';

type TestUser = { id: string; name: string };

function bankDetails(accountNumber = '1234567890') {
	return { bank: 'kbank', accountNumber, accountHolderName: 'Somchai Jaidee' };
}

function otherDetails(label = 'Wise') {
	return { label, text: 'IBAN DE89 3704 0044 0532 0130 00' };
}

/** Link `user` into `groupId` as an active member (what accepting an invite does). */
async function joinGroup(groupId: string, user: TestUser): Promise<string> {
	const [row] = await db
		.insert(members)
		.values({ groupId, userId: user.id, ...displayNameValues(user.name) })
		.returning({ id: members.id });
	return row.id;
}

/** Soft-deactivate a member row (PLAN §6.3). */
async function deactivate(memberId: string): Promise<void> {
	await db.update(members).set({ deactivatedAt: new Date() }).where(eq(members.id, memberId));
}

/** How many audit rows name `userId` as the actor (ADR-0016: always zero here). */
async function auditRowsFor(userId: string): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(auditLog)
		.where(eq(auditLog.actorUserId, userId));
	return row.total;
}

describeIntegration('integration: receiving-method service (PLAN §17; ADR-0016)', () => {
	let owner: TestUser;

	beforeEach(async () => {
		owner = await createTestUser('owner');
	});

	afterEach(async () => {
		// `receiving_method.user_id` is ON DELETE CASCADE, so the shared cleanup's
		// user delete takes every row this suite wrote.
		await cleanupSuiteRows();
	});

	// ── Owner operations ──────────────────────────────────────────────────────

	it('appends each new method at max(position) + 1, starting at 0', async () => {
		const first = await create(owner.id, 'th_bank_account', bankDetails());
		const second = await create(owner.id, 'th_promptpay', {
			proxyType: 'mobile',
			proxyValue: '0812345678',
			accountHolderName: 'Somchai Jaidee'
		});
		const third = await create(owner.id, 'other', otherDetails());

		expect([first.position, second.position, third.position]).toEqual([0, 1, 2]);
		expect((await listOwn(owner.id)).map((m) => m.id)).toEqual([first.id, second.id, third.id]);
	});

	it('counts positions per user, so a second user also starts at 0', async () => {
		await create(owner.id, 'th_bank_account', bankDetails());
		const stranger = await createTestUser('stranger');

		const theirs = await create(stranger.id, 'th_bank_account', bankDetails('9999999999'));

		expect(theirs.position).toBe(0);
		expect(await listOwn(stranger.id)).toHaveLength(1);
	});

	it('stores the PARSED details, so no stray key reaches the jsonb column', async () => {
		const created = await create(owner.id, 'th_bank_account', {
			...bankDetails(),
			accountHolderName: '  Somchai Jaidee  ',
			admin: true
		});

		const [row] = await db.select().from(receivingMethod).where(eq(receivingMethod.id, created.id));
		expect(row.details).toEqual(bankDetails());
	});

	it('rejects details the rail’s schema refuses, and writes nothing', async () => {
		await expect(
			create(owner.id, 'th_bank_account', { ...bankDetails(), accountNumber: '12-34' })
		).rejects.toBeInstanceOf(InvalidReceivingMethodError);

		expect(await listOwn(owner.id)).toEqual([]);
	});

	it('update replaces the details and leaves the rail and position alone', async () => {
		const created = await create(owner.id, 'th_bank_account', bankDetails());

		const updated = await update(owner.id, created.id, bankDetails('5555555555'));

		expect(updated.rail).toBe('th_bank_account');
		expect(updated.position).toBe(created.position);
		expect(updated.details).toEqual(bankDetails('5555555555'));
	});

	it('remove HARD-deletes the row — nothing references it (PLAN §17.5)', async () => {
		const created = await create(owner.id, 'other', otherDetails());

		await remove(owner.id, created.id);

		const rows = await db.select().from(receivingMethod).where(eq(receivingMethod.id, created.id));
		expect(rows).toEqual([]);
		expect(await listOwn(owner.id)).toEqual([]);
	});

	// ── Another user's row is NOT FOUND, never a 403 ───────────────────────────

	it('update / remove / reorder against another user’s row → NOT FOUND', async () => {
		const created = await create(owner.id, 'th_bank_account', bankDetails());
		const intruder = await createTestUser('intruder');

		await expect(update(intruder.id, created.id, bankDetails('5555555555'))).rejects.toBeInstanceOf(
			ReceivingMethodNotFoundError
		);
		await expect(remove(intruder.id, created.id)).rejects.toBeInstanceOf(
			ReceivingMethodNotFoundError
		);
		// The intruder has no methods at all, so the owner's id is simply "extra":
		// the reorder is refused without revealing that the id exists.
		await expect(reorder(intruder.id, [created.id])).rejects.toBeInstanceOf(
			ReceivingMethodOrderMismatchError
		);

		// The row is untouched by all three attempts.
		const [row] = await db.select().from(receivingMethod).where(eq(receivingMethod.id, created.id));
		expect(row.details).toEqual(bankDetails());
	});

	it('listOwn never returns another user’s methods, even inside a shared group', async () => {
		const other = await createTestUser('other');
		const group = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		await joinGroup(group.id, other);
		await create(other.id, 'th_bank_account', bankDetails('7777777777'));

		expect(await listOwn(owner.id)).toEqual([]);
	});

	// ── reorder ───────────────────────────────────────────────────────────────

	it('reorder rewrites every position in one transaction', async () => {
		const a = await create(owner.id, 'th_bank_account', bankDetails('1111111111'));
		const b = await create(owner.id, 'th_bank_account', bankDetails('2222222222'));
		const c = await create(owner.id, 'th_bank_account', bankDetails('3333333333'));

		const reordered = await reorder(owner.id, [c.id, a.id, b.id]);

		expect(reordered.map((m) => m.id)).toEqual([c.id, a.id, b.id]);
		expect(reordered.map((m) => m.position)).toEqual([0, 1, 2]);
		expect((await listOwn(owner.id)).map((m) => m.id)).toEqual([c.id, a.id, b.id]);
	});

	it('reorder is ATOMIC: a mismatched id set moves nothing', async () => {
		const a = await create(owner.id, 'th_bank_account', bankDetails('1111111111'));
		const b = await create(owner.id, 'th_bank_account', bankDetails('2222222222'));
		const c = await create(owner.id, 'th_bank_account', bankDetails('3333333333'));

		// `c` is missing from the submitted order — a partially applied reorder would
		// have already moved `b` to position 0 by the time it noticed.
		await expect(reorder(owner.id, [b.id, a.id])).rejects.toBeInstanceOf(
			ReceivingMethodOrderMismatchError
		);

		expect((await listOwn(owner.id)).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
		expect((await listOwn(owner.id)).map((m) => m.position)).toEqual([0, 1, 2]);
	});

	it('reorder rejects a duplicated id and an unknown id', async () => {
		const a = await create(owner.id, 'th_bank_account', bankDetails('1111111111'));
		const b = await create(owner.id, 'th_bank_account', bankDetails('2222222222'));

		await expect(reorder(owner.id, [a.id, a.id])).rejects.toBeInstanceOf(
			ReceivingMethodOrderMismatchError
		);
		await expect(reorder(owner.id, [a.id, b.id, 'no-such-id'])).rejects.toBeInstanceOf(
			ReceivingMethodOrderMismatchError
		);
	});

	// ── Visibility (PLAN §17.3) — the security-critical rule ───────────────────

	it('a co-member in a shared group sees the profile, in preference order', async () => {
		const viewer = await createTestUser('viewer');
		const group = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		await joinGroup(group.id, viewer);

		const first = await create(owner.id, 'th_bank_account', bankDetails());
		const second = await create(owner.id, 'other', otherDetails());

		const visible = await listForViewer(viewer.id, owner.id);
		expect(visible.map((m) => m.id)).toEqual([first.id, second.id]);
	});

	it('a user who shares NO group sees nothing', async () => {
		const stranger = await createTestUser('stranger');
		await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		await createGroup({
			userId: stranger.id,
			userName: stranger.name,
			name: 'Other trip',
			settlementCurrency: 'USD'
		});
		await create(owner.id, 'th_bank_account', bankDetails());

		expect(await listForViewer(stranger.id, owner.id)).toEqual([]);
	});

	it('leaving the shared group revokes visibility on the very next read', async () => {
		const viewer = await createTestUser('viewer');
		const group = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		const viewerMemberId = await joinGroup(group.id, viewer);
		await create(owner.id, 'th_bank_account', bankDetails());

		expect(await listForViewer(viewer.id, owner.id)).toHaveLength(1);

		// Visibility is DERIVED, never stored: nothing is revoked, the next read
		// simply no longer finds an active member row.
		await db.delete(members).where(eq(members.id, viewerMemberId));

		expect(await listForViewer(viewer.id, owner.id)).toEqual([]);
	});

	it('a DEACTIVATED viewer sees nothing — deactivation removes their group access', async () => {
		const viewer = await createTestUser('viewer');
		const group = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		const viewerMemberId = await joinGroup(group.id, viewer);
		await create(owner.id, 'th_bank_account', bankDetails());

		await deactivate(viewerMemberId);

		expect(await listForViewer(viewer.id, owner.id)).toEqual([]);
	});

	it('a DEACTIVATED target is still visible — you must still be able to pay them', async () => {
		// PLAN §6.3: deactivating does not clear outstanding balances, and the
		// settle screen still shows what a departed member is owed. The asymmetry
		// with the viewer above is the point.
		const viewer = await createTestUser('viewer');
		const group = await createGroup({
			userId: viewer.id,
			userName: viewer.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		const targetMemberId = await joinGroup(group.id, owner);
		const created = await create(owner.id, 'th_bank_account', bankDetails());

		await deactivate(targetMemberId);

		expect((await listForViewer(viewer.id, owner.id)).map((m) => m.id)).toEqual([created.id]);
	});

	it('a soft-deleted group grants nothing', async () => {
		const viewer = await createTestUser('viewer');
		const group = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		await joinGroup(group.id, viewer);
		await create(owner.id, 'th_bank_account', bankDetails());

		await db.update(groups).set({ deletedAt: new Date() }).where(eq(groups.id, group.id));

		expect(await listForViewer(viewer.id, owner.id)).toEqual([]);
	});

	it('sharing ANY group is enough, and one shared group is not counted twice', async () => {
		const viewer = await createTestUser('viewer');
		// A group the viewer is NOT in, to prove it neither grants nor blocks.
		await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Alone',
			settlementCurrency: 'USD'
		});
		const shared = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Shared',
			settlementCurrency: 'USD'
		});
		const alsoShared = await createGroup({
			userId: owner.id,
			userName: owner.name,
			name: 'Also shared',
			settlementCurrency: 'USD'
		});
		await joinGroup(shared.id, viewer);
		await joinGroup(alsoShared.id, viewer);
		const created = await create(owner.id, 'th_bank_account', bankDetails());

		// Two shared groups; the profile is listed ONCE (an EXISTS predicate, not a
		// join that would fan the rows out).
		expect((await listForViewer(viewer.id, owner.id)).map((m) => m.id)).toEqual([created.id]);
	});

	it('an UNLINKED member slot carries no profile (PLAN §17.1)', async () => {
		const viewer = await createTestUser('viewer');
		const group = await createGroup({
			userId: viewer.id,
			userName: viewer.name,
			name: 'Trip',
			settlementCurrency: 'USD'
		});
		// A slot with no `user_id` — there is no user whose profile to look up, and
		// nobody can record details on their behalf.
		await db.insert(members).values({ groupId: group.id, ...displayNameValues('Guest') });

		expect(await listForViewer(viewer.id, 'no-such-user')).toEqual([]);
	});

	// ── ADR-0016: no audit row, ever ──────────────────────────────────────────

	it('writes NO audit_log row for create / update / remove / reorder', async () => {
		expect(await auditRowsFor(owner.id)).toBe(0);

		const a = await create(owner.id, 'th_bank_account', bankDetails('1111111111'));
		const b = await create(owner.id, 'other', otherDetails());
		await update(owner.id, a.id, bankDetails('2222222222'));
		await reorder(owner.id, [b.id, a.id]);
		await remove(owner.id, b.id);

		// All four mutations really happened…
		expect((await listOwn(owner.id)).map((m) => m.id)).toEqual([a.id]);
		// …and the audit table is still empty (ADR-0016). `audit_log` rows are
		// GROUP-scoped and readable by every member of that group; a receiving method
		// belongs to a USER, so there is no correct `group_id` to write, and fanning
		// one out would broadcast "X changed their bank account" into every group
		// they are in. Do NOT "fix" this.
		expect(await auditRowsFor(owner.id)).toBe(0);
	});
});
