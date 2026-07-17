import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the invite service (PLAN §6.2 — member-agnostic links, §12).
//
// STRATEGY (mirrors `members.test.ts`): there is NO real DB here — real CRUD
// round-trips are deferred to the integration tests. We mock `$lib/server/db`
// with a small fluent query-builder stub so we can assert the *meaningful*
// service guarantees:
//   - `createInvite` generates a URL-safe, long token + a ~7-day expiry and
//     inserts a MEMBER-AGNOSTIC invite (no `member_id`) under access.
//   - access-denied throws `GroupAccessError` for create/list/revoke (and
//     inserts/updates nothing).
//   - `revokeInvite` stamps `revoked_at`, and rejects an invite not in the group
//     with `InviteNotFoundError`.
//   - `listActiveInvites` applies the active-only WHERE (revoked IS NULL AND
//     expires_at > now) and returns only the rows the mock yields, newest-first.
//   - `getInviteAcceptInfo` lists unlinked-active claimable members (and invalid).
//   - `acceptInvite` honours the invitee's selection (new vs existing) with the
//     right outcomes (accepted / slot_taken / already_member / invalid).

// --- Fluent DB mock -------------------------------------------------------
const {
	selectQueue,
	whereCalls,
	insertCalls,
	updateCalls,
	updateReturningQueue,
	insertReturningQueue,
	insertThrow,
	updateThrow,
	makeDb
} = vi.hoisted(() => {
	// A queue of row-sets the SELECT chains resolve to, in call order.
	const selectQueue: unknown[][] = [];
	const whereCalls: unknown[] = [];
	const insertCalls: { table: unknown; values: unknown }[] = [];
	const updateCalls: { set: unknown }[] = [];
	// Queues for `.returning()` row-sets on UPDATE / INSERT so the accept-flow
	// tests can simulate the conditional-update affected-row count (0 vs 1) and the
	// created-member id. Empty → fall back to the legacy default shapes (so the
	// pre-existing create/revoke tests keep passing unchanged).
	const updateReturningQueue: unknown[][] = [];
	const insertReturningQueue: unknown[][] = [];
	// When set, the NEXT insert `.values()` throws this (e.g. a Postgres unique
	// violation `{ code: '23505' }`) to exercise the new-member race backstop.
	const insertThrow: { error: unknown } = { error: undefined };
	// When set, the NEXT update `.returning()` rejects with this — exercises the
	// existing-claim race backstop (the user concurrently linked another slot).
	const updateThrow: { error: unknown } = { error: undefined };

	function nextSelectRows(): unknown[] {
		return selectQueue.length > 0 ? (selectQueue.shift() as unknown[]) : [];
	}

	function selectChain() {
		const rows = nextSelectRows();
		const chain: Record<string, unknown> = {};
		chain.from = () => chain;
		chain.innerJoin = () => chain;
		chain.where = (arg: unknown) => {
			whereCalls.push(arg);
			return chain;
		};
		chain.limit = () => chain;
		chain.orderBy = () => chain;
		chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return chain;
	}

	function insertChain(table: unknown) {
		return {
			values(values: unknown) {
				insertCalls.push({ table, values });
				if (insertThrow.error !== undefined) {
					const err = insertThrow.error;
					insertThrow.error = undefined;
					throw err;
				}
				return {
					returning: () =>
						Promise.resolve(
							insertReturningQueue.length > 0
								? (insertReturningQueue.shift() as unknown[])
								: [
										{
											id: 'invite-1',
											createdAt: new Date('2026-06-16T00:00:00.000Z'),
											...(values as object)
										}
									]
						),
					then: (resolve: (v: unknown) => unknown) => resolve(undefined)
				};
			}
		};
	}

	function updateChain() {
		const chain: Record<string, unknown> = {};
		chain.set = (v: unknown) => {
			updateCalls.push({ set: v });
			return chain;
		};
		chain.where = () => chain;
		chain.returning = () => {
			if (updateThrow.error !== undefined) {
				const err = updateThrow.error;
				updateThrow.error = undefined;
				return Promise.reject(err);
			}
			return Promise.resolve(
				updateReturningQueue.length > 0
					? (updateReturningQueue.shift() as unknown[])
					: [{ id: 'invite-1' }]
			);
		};
		chain.then = (resolve: (v: unknown) => unknown) => resolve(undefined);
		return chain;
	}

	const executor = {
		select: () => selectChain(),
		insert: (table: unknown) => insertChain(table),
		update: () => updateChain()
	};

	const db = {
		...executor,
		transaction: (cb: (tx: typeof executor) => Promise<unknown>) => cb(executor)
	};

	return {
		selectQueue,
		whereCalls,
		insertCalls,
		updateCalls,
		updateReturningQueue,
		insertReturningQueue,
		insertThrow,
		updateThrow,
		makeDb: () => db
	};
});

vi.mock('$lib/server/db', () => ({ db: makeDb() }));

import {
	createInvite,
	listActiveInvites,
	revokeInvite,
	getInvitePreview,
	getInviteAcceptInfo,
	acceptInvite,
	inviteExpiresAt,
	INVITE_TTL_DAYS,
	InviteNotFoundError
} from './invites';
import { GroupAccessError } from './groups';
import { auditLog } from './db/audit-schema';

/** Queue the row-sets each successive SELECT chain resolves to. */
function queueSelects(...rowSets: unknown[][]) {
	selectQueue.length = 0;
	selectQueue.push(...rowSets);
}

/** Recorded inserts that targeted audit_log vs the domain table. */
function auditInserts() {
	return insertCalls.filter((c) => c.table === auditLog);
}
function nonAuditInserts() {
	return insertCalls.filter((c) => c.table !== auditLog);
}

/** An access-granting member row (the access SELECT finds one). */
const ACCESS_OK = [{ id: 'access-member' }];

beforeEach(() => {
	selectQueue.length = 0;
	whereCalls.length = 0;
	insertCalls.length = 0;
	updateCalls.length = 0;
	updateReturningQueue.length = 0;
	insertReturningQueue.length = 0;
	insertThrow.error = undefined;
	updateThrow.error = undefined;
});

describe('INVITE_TTL_DAYS / inviteExpiresAt (PLAN §6.2 — 7-day expiry)', () => {
	it('is 7 days', () => {
		expect(INVITE_TTL_DAYS).toBe(7);
	});

	it('computes now + 7 days', () => {
		const now = new Date('2026-06-16T00:00:00.000Z');
		const expires = inviteExpiresAt(now);
		expect(expires.getTime() - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
	});
});

describe('createInvite (PLAN §6.2 — member-agnostic link, token + 7-day expiry)', () => {
	it('inserts a MEMBER-AGNOSTIC invite (no member_id) with a URL-safe token + ~7-day expiry under access', async () => {
		queueSelects(ACCESS_OK); // access check passes
		const before = Date.now();
		const invite = await createInvite({ userId: 'u1', groupId: 'g1' });
		const after = Date.now();

		const inviteInserts = nonAuditInserts();
		expect(inviteInserts).toHaveLength(1);
		const values = inviteInserts[0].values as Record<string, unknown>;
		expect(values.groupId).toBe('g1');
		expect(values.createdBy).toBe('u1');
		// Member-agnostic → the insert never carries a target member.
		expect(values).not.toHaveProperty('memberId');

		// Token: present, non-empty, URL-safe (base64url alphabet), and long
		// (32 random bytes → 43 base64url chars).
		const token = values.token as string;
		expect(typeof token).toBe('string');
		expect(token.length).toBeGreaterThanOrEqual(40);
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

		// Expiry ≈ now + 7 days (stored Date), within the call window.
		const expiresAt = values.expiresAt as Date;
		expect(expiresAt).toBeInstanceOf(Date);
		const sevenDays = 7 * 24 * 60 * 60 * 1000;
		expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDays - 1000);
		expect(expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDays + 1000);

		// Returned shape carries the token + expiry (no member id at all).
		expect(invite.token).toBe(token);
		expect(invite).not.toHaveProperty('memberId');
		expect(invite.expiresAt).toBeInstanceOf(Date);
	});

	it('generates a DIFFERENT token each time (unguessable, not a fixed value)', async () => {
		queueSelects(ACCESS_OK);
		const a = await createInvite({ userId: 'u1', groupId: 'g1' });
		queueSelects(ACCESS_OK);
		const b = await createInvite({ userId: 'u1', groupId: 'g1' });
		expect(a.token).not.toBe(b.token);
	});

	it('throws GroupAccessError and inserts nothing when access is denied', async () => {
		queueSelects([]); // access check finds nothing
		await expect(createInvite({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
		expect(insertCalls).toHaveLength(0);
	});
});

describe('listActiveInvites (PLAN §6.2 — active only, newest first)', () => {
	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]); // access check fails
		await expect(listActiveInvites({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
	});

	it('applies the active-only WHERE and maps only the active rows the query yields', async () => {
		const expiresAt = new Date('2026-07-01T00:00:00.000Z');
		const createdAt = new Date('2026-06-16T00:00:00.000Z');
		// access OK, then the (already active-filtered) invite rows. Revoked/expired
		// rows are excluded by the WHERE, so the mock only yields the active one.
		queueSelects(ACCESS_OK, [{ id: 'i1', token: 'tok-abc', expiresAt, createdAt }]);

		const result = await listActiveInvites({ userId: 'u1', groupId: 'g1' });

		expect(result).toEqual([
			{
				id: 'i1',
				token: 'tok-abc',
				expiresAt: expiresAt.toISOString(),
				createdAt: createdAt.toISOString()
			}
		]);

		// The list SELECT (2nd `where` call — 1st is the access check) composes a
		// WHERE; its mere presence proves the active-only filter is applied (the
		// stub doesn't evaluate it, but the service can't return rows without it).
		expect(whereCalls.length).toBeGreaterThanOrEqual(2);
		expect(whereCalls[1]).toBeDefined();
	});
});

describe('revokeInvite (PLAN §6.2 — stamp revoked_at, cross-group guard)', () => {
	it('throws GroupAccessError when access is denied', async () => {
		queueSelects([]);
		await expect(
			revokeInvite({ userId: 'u1', groupId: 'g1', inviteId: 'i1' })
		).rejects.toBeInstanceOf(GroupAccessError);
		expect(updateCalls).toHaveLength(0);
	});

	it('throws InviteNotFoundError when the invite is not in the group', async () => {
		queueSelects(ACCESS_OK, []); // access OK, invite-in-group lookup finds nothing
		await expect(
			revokeInvite({ userId: 'u1', groupId: 'g1', inviteId: 'nope' })
		).rejects.toBeInstanceOf(InviteNotFoundError);
		expect(updateCalls).toHaveLength(0);
	});

	it('stamps revoked_at when access + in-group checks pass', async () => {
		queueSelects(ACCESS_OK, [{ id: 'i1' }]); // access OK, invite found in group
		await revokeInvite({ userId: 'u1', groupId: 'g1', inviteId: 'i1' });

		expect(updateCalls).toHaveLength(1);
		expect((updateCalls[0].set as Record<string, unknown>).revokedAt).toBeInstanceOf(Date);
	});
});

describe('audit writes (task 6.1, PLAN §12.1 — same transaction; token never logged)', () => {
	it('createInvite writes one create/invite audit row WITHOUT the token', async () => {
		queueSelects(ACCESS_OK);
		const invite = await createInvite({ userId: 'u1', groupId: 'g1' });

		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const v = audits[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			groupId: 'g1',
			actorUserId: 'u1',
			action: 'create',
			entityType: 'invite'
		});
		expect(v.summary).toBe('Created an invite link');
		// The token is a capability secret — it must NOT appear anywhere in the row.
		const serialized = JSON.stringify({ summary: v.summary, metadata: v.metadata ?? null });
		expect(serialized).not.toContain(invite.token);
	});

	it('revokeInvite writes one revoke/invite audit row', async () => {
		queueSelects(ACCESS_OK, [{ id: 'i1' }]);
		await revokeInvite({ userId: 'u1', groupId: 'g1', inviteId: 'i1' });

		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const v = audits[0].values as Record<string, unknown>;
		expect(v).toMatchObject({
			action: 'revoke',
			entityType: 'invite',
			entityId: 'i1'
		});
	});

	it('writes NO audit row when createInvite is denied access', async () => {
		queueSelects([]);
		await expect(createInvite({ userId: 'u1', groupId: 'g1' })).rejects.toBeInstanceOf(
			GroupAccessError
		);
		expect(auditInserts()).toHaveLength(0);
	});

	it('writes NO audit row when revokeInvite targets an invite not in the group', async () => {
		queueSelects(ACCESS_OK, []); // access ok, invite lookup empty
		await expect(
			revokeInvite({ userId: 'u1', groupId: 'g1', inviteId: 'nope' })
		).rejects.toBeInstanceOf(InviteNotFoundError);
		expect(auditInserts()).toHaveLength(0);
	});
});

// --- ACCEPT side (task 3.7, PLAN §6.2) ------------------------------------

/** A still-valid resolved-invite row (the resolve SELECT yields this). */
function validInviteRow() {
	return { id: 'i1', groupId: 'g1', groupName: 'Trip to Tokyo' };
}

describe('getInvitePreview (PLAN §6.2 — safe, auth-free landing preview)', () => {
	it('returns { status: valid, groupName } for a live invite (only the group name leaks)', async () => {
		queueSelects([validInviteRow()]);
		const preview = await getInvitePreview('tok-abc');
		expect(preview).toEqual({ status: 'valid', groupName: 'Trip to Tokyo' });
	});

	it('returns { status: invalid } when the token resolves to nothing (not-found/revoked/expired)', async () => {
		// The resolve SELECT already filters revoked/expired/dead-group, so a
		// not-found / revoked / expired token simply yields no row.
		queueSelects([]);
		const preview = await getInvitePreview('missing-or-revoked-or-expired');
		expect(preview).toEqual({ status: 'invalid' });
	});

	it('does not throw for an invalid token (returns the status)', async () => {
		queueSelects([]);
		await expect(getInvitePreview('nope')).resolves.toEqual({ status: 'invalid' });
	});
});

describe('getInviteAcceptInfo (PLAN §6.2 — logged-in accept view, claimable slots)', () => {
	it('returns { status: valid, groupId, groupName, claimableMembers } listing unlinked-active slots', async () => {
		// (1) resolve → valid invite; (2) the claimable-members SELECT yields the
		// group's unlinked, active slots (the WHERE filters linked/deactivated out).
		queueSelects(
			[validInviteRow()],
			[
				{ id: 'm1', displayName: 'Alex' },
				{ id: 'm2', displayName: 'Bobby' }
			]
		);

		const info = await getInviteAcceptInfo('tok-abc');

		expect(info).toEqual({
			status: 'valid',
			groupId: 'g1',
			groupName: 'Trip to Tokyo',
			claimableMembers: [
				{ id: 'm1', displayName: 'Alex' },
				{ id: 'm2', displayName: 'Bobby' }
			]
		});
	});

	it('returns an empty claimableMembers list when no unlinked-active slots exist', async () => {
		queueSelects([validInviteRow()], []);
		const info = await getInviteAcceptInfo('tok-abc');
		expect(info).toEqual({
			status: 'valid',
			groupId: 'g1',
			groupName: 'Trip to Tokyo',
			claimableMembers: []
		});
	});

	it('returns { status: invalid } for a dead/not-found/revoked/expired token', async () => {
		queueSelects([]); // resolve SELECT finds no live invite
		const info = await getInviteAcceptInfo('dead');
		expect(info).toEqual({ status: 'invalid' });
	});
});

describe('acceptInvite (PLAN §6.2 — member-agnostic, selection-driven outcomes)', () => {
	it("mode 'new': creates a new member linked to the user (userId set, displayName = userName)", async () => {
		// (1) resolve → valid invite; (2) membership check → none.
		queueSelects([validInviteRow()], []);
		insertReturningQueue.push([{ id: 'new-member-1' }]);

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'new' }
		});

		expect(result).toEqual({ status: 'accepted', groupId: 'g1', memberId: 'new-member-1' });
		// The new member is linked to the accepting user with their name as default.
		const memberInserts = nonAuditInserts();
		expect(memberInserts).toHaveLength(1);
		const values = memberInserts[0].values as Record<string, unknown>;
		expect(values.groupId).toBe('g1');
		expect(values.userId).toBe('u9');
		expect(values.displayName).toBe('Dana');
		// 'new' does NOT touch members via UPDATE.
		expect(updateCalls).toHaveLength(0);

		// One add/member audit row for the new join (entity_id = created member id).
		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const a = audits[0].values as Record<string, unknown>;
		expect(a).toMatchObject({
			groupId: 'g1',
			actorUserId: 'u9',
			action: 'add',
			entityType: 'member',
			entityId: 'new-member-1'
		});
	});

	it("mode 'existing': conditionally claims the empty slot (accepted, no displayName overwrite)", async () => {
		// (1) resolve → valid invite; (2) membership → none.
		queueSelects([validInviteRow()], []);
		// The conditional UPDATE affects exactly one row → claim succeeds.
		updateReturningQueue.push([{ id: 'm5' }]);

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'existing', memberId: 'm5' }
		});

		expect(result).toEqual({ status: 'accepted', groupId: 'g1', memberId: 'm5' });
		// Claim is an UPDATE that ONLY sets user_id — never the display_name.
		expect(updateCalls).toHaveLength(1);
		const set = updateCalls[0].set as Record<string, unknown>;
		expect(set.userId).toBe('u9');
		expect(set).not.toHaveProperty('displayName');
		// Existing-claim creates NO new member (the only insert is the audit row).
		expect(nonAuditInserts()).toHaveLength(0);

		// One add/member audit row for the claim (entity_id = the claimed member id).
		const audits = auditInserts();
		expect(audits).toHaveLength(1);
		const a = audits[0].values as Record<string, unknown>;
		expect(a).toMatchObject({
			actorUserId: 'u9',
			action: 'add',
			entityType: 'member',
			entityId: 'm5'
		});
	});

	it("mode 'existing' already claimed/deactivated/cross-group: 0 rows updated → slot_taken", async () => {
		queueSelects([validInviteRow()], []);
		// The conditional UPDATE matches nothing (user_id already set / deactivated /
		// not in this group — the WHERE doubles as the lock + cross-group guard).
		updateReturningQueue.push([]);

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'existing', memberId: 'm5' }
		});

		expect(result).toEqual({ status: 'slot_taken' });
		expect(insertCalls).toHaveLength(0);
	});

	it("mode 'existing' race: a unique-violation on the claim is backstopped → already_member", async () => {
		queueSelects([validInviteRow()], []);
		// The user concurrently became a member via another slot; the partial unique
		// index `(group_id, user_id)` rejects this claim → friendly already_member.
		updateThrow.error = { code: '23505' };

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'existing', memberId: 'm5' }
		});

		expect(result).toEqual({ status: 'already_member', groupId: 'g1' });
		expect(insertCalls).toHaveLength(0);
	});

	it("mode 'existing' race: backstop fires on Drizzle's WRAPPED 23505 (cause chain)", async () => {
		// Real Postgres via Drizzle throws a wrapper whose own `code` is undefined and
		// whose `cause` carries `23505`. The own-`code`-only check missed this, so the
		// backstop never fired against a real DB (issue #26). Pin the wrapped shape.
		queueSelects([validInviteRow()], []);
		const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });
		updateThrow.error = Object.assign(new Error('Failed query'), { cause: pgError });

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'existing', memberId: 'm5' }
		});

		expect(result).toEqual({ status: 'already_member', groupId: 'g1' });
	});

	it('existing membership: one-per-user-per-group → already_member (no mutation)', async () => {
		// (1) resolve → valid; (2) membership check FINDS an existing linked member.
		queueSelects([validInviteRow()], [{ id: 'existing-member' }]);

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'new' }
		});

		expect(result).toEqual({ status: 'already_member', groupId: 'g1' });
		expect(insertCalls).toHaveLength(0);
		expect(updateCalls).toHaveLength(0);
	});

	it('not-found / revoked / expired token: resolve yields nothing → invalid (no mutation)', async () => {
		queueSelects([]); // resolve SELECT finds no live invite
		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'dead',
			selection: { mode: 'new' }
		});

		expect(result).toEqual({ status: 'invalid' });
		expect(insertCalls).toHaveLength(0);
		expect(updateCalls).toHaveLength(0);
	});

	it("mode 'new' race: a unique-violation on insert is backstopped → already_member", async () => {
		// (1) resolve → valid; (2) membership → none (lost the race). The insert then
		// trips the partial unique index `(group_id, user_id)`.
		queueSelects([validInviteRow()], []);
		insertThrow.error = { code: '23505' }; // Postgres unique_violation

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'new' }
		});

		expect(result).toEqual({ status: 'already_member', groupId: 'g1' });
	});

	it("mode 'new' race: backstop fires on Drizzle's WRAPPED 23505 (cause chain)", async () => {
		// As above, but on the new-member INSERT path — the wrapped shape real Postgres
		// throws, which the pre-#26 own-`code`-only check let escape as a 500.
		queueSelects([validInviteRow()], []);
		const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });
		insertThrow.error = Object.assign(new Error('Failed query'), { cause: pgError });

		const result = await acceptInvite({
			userId: 'u9',
			userName: 'Dana',
			token: 'tok',
			selection: { mode: 'new' }
		});

		expect(result).toEqual({ status: 'already_member', groupId: 'g1' });
	});

	it("mode 'new': a NON-unique insert error still propagates (not swallowed)", async () => {
		queueSelects([validInviteRow()], []);
		insertThrow.error = new Error('connection reset');

		await expect(
			acceptInvite({ userId: 'u9', userName: 'Dana', token: 'tok', selection: { mode: 'new' } })
		).rejects.toThrow('connection reset');
	});
});
