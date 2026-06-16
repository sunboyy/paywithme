// Invite service — the testable business logic for invite links (PLAN §6.2, §12).
// CLAUDE.md: "Business logic in lib/server/".
//
// This is the SERVER-SIDE SERVICE LAYER only — NOT routes/pages. The invite
// section on `/groups/[id]/members` is the route half of task 3.6. The ACCEPT
// flow (`/invite/[token]` — validate token, assign/create member) is task 3.7
// and is intentionally NOT built here; this task only covers CREATE / COPY /
// REVOKE management. We just STORE `expires_at` / `revoked_at`; the 7-day-expiry
// and revoked checks are ENFORCED at accept-time in 3.7.
//
// AUTHORIZATION (PLAN §12): "Authorization is group-membership based only … the
// single enforced check is that the requesting user has access to the group via
// a linked member." Every function below takes the acting `userId` and gates on
// `assertGroupAccess` (the task-3.3 primitive). Mutations that target a specific
// invite / member ALSO verify it belongs to `groupId` (never act cross-group).
//
// MEMBER-AGNOSTIC LINKS (PLAN §6.2): an invite link grants entry to the GROUP,
// not to a pre-chosen member slot. It carries no `member_id`. The invitee decides
// HOW to join at accept time — either CLAIM an existing unlinked, active member
// slot (keeping its display_name) or JOIN AS A NEW member (display_name = their
// own name). One member per user per group is still enforced.
//
// ERROR MODEL (consistent with the 3.3/3.5 services) and HTTP MAPPING intent:
//   - `GroupAccessError` (reused from `./groups`)  → 404: no access / group not
//     found / soft-deleted — deliberately conflated so we never leak existence.
//   - `InviteNotFoundError` (defined here)         → 404: the target invite does
//     not exist in this group. Same not-found outcome, distinct `code`.
//
// TOKEN SECURITY: the token is the URL secret that grants group access on accept,
// so it must be cryptographically strong and UNGUESSABLE — we use Node `crypto`
// `randomBytes(32).toString('base64url')` (256 bits of entropy, URL-safe), NOT
// `crypto.randomUUID()` (only 122 bits and not intended as an unguessable
// capability token). The token is NEVER logged.
//
// AUDIT LOG — DEFERRED (do NOT build here): the `audit_log` table (task 4.2) and
// the same-transaction write helper (task 4.6) don't exist yet; invite audit
// writes are retrofitted in task 6.1. Per PLAN §12.1 every mutation must
// eventually append an immutable `audit_log` row in the SAME DB transaction, so
// each mutation below runs inside `db.transaction(...)` and carries a `TODO(6.1)`
// at the exact insert site, making the retrofit mechanical.

import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db } from './db';
import { groups, invites, members } from './db/groups-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>;

/**
 * Default invite lifetime (PLAN §6.2 / decision #12): a link is reusable with a
 * **7-day expiry**. Exported so the route/UI and tests share one constant.
 */
export const INVITE_TTL_DAYS = 7;

/** Compute the expiry timestamp for a freshly-created invite: `now + 7 days`. */
export function inviteExpiresAt(now: Date = new Date()): Date {
	return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Generate a cryptographically strong, URL-safe, unguessable invite token.
 *
 * 32 random bytes (256 bits) encoded as base64url → only `[A-Za-z0-9_-]`, safe to
 * drop into `${origin}/invite/${token}` without escaping. NOT a UUID: this token
 * is a CAPABILITY (it grants group access on accept), so it needs full random
 * entropy, not a structured/lower-entropy identifier. The value is never logged.
 */
function generateInviteToken(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * Access denied OR invite not found in this group — distinct `code` from
 * `GroupAccessError` so the route can branch, but the same not-found (404)
 * outcome. We never act on an invite outside the asserted group.
 */
export class InviteNotFoundError extends Error {
	readonly code = 'invite_not_found' as const;
	constructor(message = 'Invite not found') {
		super(message);
		this.name = 'InviteNotFoundError';
	}
}

/** Assert access or throw `GroupAccessError` (→ 404). */
async function assertGroupAccess(
	userId: string,
	groupId: string,
	executor: DbExecutor = db
): Promise<void> {
	if (!(await userHasGroupAccess(userId, groupId, executor))) {
		throw new GroupAccessError();
	}
}

/** A raw invite row as stored. */
export type Invite = typeof invites.$inferSelect;

/** The created-invite shape returned to the caller (incl. the token + expiry). */
export type CreatedInvite = {
	id: string;
	token: string;
	expiresAt: Date;
	createdAt: Date;
};

/** The active-invite shape the management list renders (PLAN §6.2). */
export type ActiveInvite = {
	id: string;
	token: string;
	expiresAt: string;
	createdAt: string;
};

/**
 * Create a MEMBER-AGNOSTIC invite link for a group (PLAN §6.2). Access-checked.
 * The link is REUSABLE with a 7-day expiry; a group may have MULTIPLE active links
 * at once. It carries NO target member — the invitee decides at accept time
 * whether to claim an existing slot or join as a new member.
 *
 * Generates an unguessable token (`randomBytes(32).base64url`), sets
 * `expiresAt = now + INVITE_TTL_DAYS days`, and inserts inside a transaction.
 * Returns the created invite (incl. token + expiresAt). NEVER logs the token.
 */
export async function createInvite({
	userId,
	groupId
}: {
	userId: string;
	groupId: string;
}): Promise<CreatedInvite> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		const [invite] = await tx
			.insert(invites)
			.values({
				groupId,
				token: generateInviteToken(),
				expiresAt: inviteExpiresAt(),
				createdBy: userId
			})
			.returning();

		// TODO(6.1): append audit_log row (action='create', entity_type='invite') in
		// this same transaction. Do NOT include the raw token in the audit summary.
		return {
			id: invite.id,
			token: invite.token,
			expiresAt: invite.expiresAt,
			createdAt: invite.createdAt
		};
	});
}

/**
 * List the ACTIVE invite links for a group (PLAN §6.2 management screen).
 * Access-checked. "Active" = NOT revoked AND NOT expired:
 * `revoked_at IS NULL AND expires_at > now()`. Newest first.
 *
 * Usage count is OPTIONAL per PLAN and is DEFERRED: it isn't trackable without an
 * extra accepted-uses column/table (out of scope for 3.6), so it's omitted here.
 */
export async function listActiveInvites({
	userId,
	groupId
}: {
	userId: string;
	groupId: string;
}): Promise<ActiveInvite[]> {
	await assertGroupAccess(userId, groupId);

	const rows = await db
		.select({
			id: invites.id,
			token: invites.token,
			expiresAt: invites.expiresAt,
			createdAt: invites.createdAt
		})
		.from(invites)
		.where(
			and(
				eq(invites.groupId, groupId),
				isNull(invites.revokedAt),
				gt(invites.expiresAt, new Date())
			)
		)
		.orderBy(desc(invites.createdAt));

	return rows.map((r) => ({
		id: r.id,
		token: r.token,
		expiresAt: r.expiresAt.toISOString(),
		createdAt: r.createdAt.toISOString()
	}));
}

/**
 * Revoke an invite link (PLAN §6.2): set `revoked_at = now()` so it can no longer
 * be accepted (enforced at accept-time in 3.7). Access-checked + verifies the
 * invite belongs to `groupId` (cross-group guard → `InviteNotFoundError` / 404).
 * Idempotent: the `isNull(revokedAt)` guard means re-revoking doesn't overwrite
 * the original revoke time.
 */
export async function revokeInvite({
	userId,
	groupId,
	inviteId
}: {
	userId: string;
	groupId: string;
	inviteId: string;
}): Promise<void> {
	await db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		// Cross-group guard: confirm the invite is in THIS group before touching it,
		// so a client-supplied id from another group can't be revoked here.
		const [existing] = await tx
			.select({ id: invites.id })
			.from(invites)
			.where(and(eq(invites.id, inviteId), eq(invites.groupId, groupId)))
			.limit(1);

		if (!existing) {
			throw new InviteNotFoundError();
		}

		// Idempotent stamp: only set `revoked_at` if still null.
		await tx
			.update(invites)
			.set({ revokedAt: new Date() })
			.where(
				and(eq(invites.id, inviteId), eq(invites.groupId, groupId), isNull(invites.revokedAt))
			);

		// TODO(6.1): append audit_log row (action='revoke', entity_type='invite') in
		// this same transaction.
	});
}

// --- ACCEPT side (task 3.7, PLAN §6.2) ------------------------------------
//
// Accepting an invite ALWAYS requires a registered, logged-in user (PLAN §6.2);
// the route layer enforces the login gate and feeds us the authenticated
// `userId` + `userName`. These functions are the testable core of that flow.

/** A still-acceptable invite resolved by token, with its group name. */
type ResolvedInvite = {
	id: string;
	groupId: string;
	groupName: string;
};

/**
 * Resolve a STILL-VALID invite by token on the given executor, joining the group
 * for its name. "Valid" = exists, NOT revoked (`revoked_at IS NULL`), and NOT
 * expired (`expires_at > now`). The group must also not be soft-deleted
 * (`groups.deleted_at IS NULL`) — a dead group can't be joined. Returns `null`
 * for any invalid/not-found case (callers map that to their own status). Runs on
 * the passed executor so the accept path re-validates inside its transaction.
 */
async function resolveValidInvite(
	token: string,
	executor: DbExecutor,
	now: Date = new Date()
): Promise<ResolvedInvite | null> {
	const [row] = await executor
		.select({
			id: invites.id,
			groupId: invites.groupId,
			groupName: groups.name
		})
		.from(invites)
		.innerJoin(groups, eq(invites.groupId, groups.id))
		.where(
			and(
				eq(invites.token, token),
				isNull(invites.revokedAt),
				gt(invites.expiresAt, now),
				isNull(groups.deletedAt)
			)
		)
		.limit(1);

	return row ?? null;
}

/** The safe, auth-free landing preview (PLAN §6.2 step 2). */
export type InvitePreview =
	| { status: 'valid'; groupName: string }
	| { status: 'invalid'; groupName?: undefined };

/**
 * A SAFE preview of an invite for the `/invite/[token]` landing page, usable
 * WITHOUT auth (the accept itself still requires login). We only ever expose the
 * GROUP NAME — the holder of a valid token was invited, so showing them which
 * group they're joining is appropriate; nothing else leaks.
 *
 * `invalid` deliberately conflates not-found / revoked / expired (and a
 * soft-deleted group) so the page can't be used to probe which tokens exist.
 * Never throws for the invalid case — returns the discriminated status.
 */
export async function getInvitePreview(token: string): Promise<InvitePreview> {
	const invite = await resolveValidInvite(token, db);
	if (!invite) {
		return { status: 'invalid' };
	}
	return { status: 'valid', groupName: invite.groupName };
}

/**
 * The LOGGED-IN accept view (PLAN §6.2 step 3): everything the accept page needs
 * to let the invitee CHOOSE how to join — the group name plus the list of
 * CLAIMABLE member slots (unlinked + active). Unlike `getInvitePreview` (the
 * auth-free landing), this exposes the claimable member display names, which is
 * appropriate only for a logged-in token-holder about to join.
 */
export type InviteAcceptInfo =
	| {
			status: 'valid';
			groupId: string;
			groupName: string;
			claimableMembers: { id: string; displayName: string }[];
	  }
	| { status: 'invalid' };

/**
 * Resolve the accept-time info for a LOGGED-IN invitee (PLAN §6.2 step 3).
 *
 * No auth check here — the route only calls this for a logged-in user, and the
 * token itself is the capability that authorizes seeing the group's claimable
 * slots. Invalid/not-found/revoked/expired (or dead group) → `{ status:
 * 'invalid' }` (conflated, never throws). Otherwise lists the group's UNLINKED,
 * ACTIVE members (`user_id IS NULL AND deactivated_at IS NULL`) — the slots an
 * invitee may claim — ordered by display name.
 */
export async function getInviteAcceptInfo(token: string): Promise<InviteAcceptInfo> {
	const invite = await resolveValidInvite(token, db);
	if (!invite) {
		return { status: 'invalid' };
	}

	const claimable = await db
		.select({ id: members.id, displayName: members.displayName })
		.from(members)
		.where(
			and(
				eq(members.groupId, invite.groupId),
				isNull(members.userId),
				isNull(members.deactivatedAt)
			)
		)
		.orderBy(members.displayName);

	return {
		status: 'valid',
		groupId: invite.groupId,
		groupName: invite.groupName,
		claimableMembers: claimable
	};
}

/** Discriminated outcome of an accept attempt (PLAN §6.2). */
export type AcceptResult =
	| { status: 'invalid' }
	| { status: 'already_member'; groupId: string }
	| { status: 'slot_taken' }
	| { status: 'accepted'; groupId: string; memberId: string };

/**
 * A Postgres unique-violation error code (`23505`). The partial unique index
 * `(group_id, user_id) WHERE user_id IS NOT NULL` (task 3.1) backstops a race on
 * the OPEN-invite path: two concurrent accepts by the same user would both pass
 * the membership pre-check, then one insert wins and the other trips this — we
 * map that to a friendly `already_member` rather than a 500.
 */
function isUniqueViolation(e: unknown): boolean {
	return (
		typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === '23505'
	);
}

/**
 * The invitee's CHOICE at accept time (PLAN §6.2 step 3):
 *   - `new`      — join as a brand-new member named after the accepting user.
 *   - `existing` — claim one of the group's unlinked, active member slots.
 */
export type AcceptSelection = { mode: 'new' } | { mode: 'existing'; memberId: string };

/**
 * Accept a MEMBER-AGNOSTIC invite for an authenticated user (PLAN §6.2 step 3 +
 * Rules). The invitee's `selection` decides HOW they join.
 *
 * Returns a DISCRIMINATED result (NOT exceptions) for every EXPECTED outcome so
 * the route can branch deterministically:
 *   - `invalid`        — token not found / revoked / expired (or dead group).
 *   - `already_member` — the user already has a member link in this group
 *                        (one-member-per-user-per-group → friendly no-op).
 *   - `slot_taken`     — `existing` claim of a slot that is already linked,
 *                        deactivated, or not in this group (single-use per slot).
 *   - `accepted`       — claimed an existing slot, OR created+linked a new member.
 *
 * One transaction, re-validated inside it:
 *  1. Re-resolve the invite (not-found/revoked/expired → `invalid`).
 *  2. One-per-user-per-group: existing member link for `userId` → `already_member`.
 *  3. `existing`: a CONDITIONAL update claims the slot atomically —
 *     `SET user_id = :userId WHERE id = :memberId AND group_id = :groupId AND
 *     user_id IS NULL AND deactivated_at IS NULL`. 0 rows → `slot_taken` (already
 *     claimed / deactivated / cross-group — the WHERE doubles as the lock AND the
 *     cross-group guard); else `accepted`. The slot's existing `display_name` is
 *     NEVER overwritten. Wrapped in the unique-violation catch in case the user
 *     concurrently became a member via another slot (→ `already_member`).
 *  4. `new`: insert a new member `{ groupId, userId, displayName: userName }`. A
 *     concurrent double-accept is backstopped by the partial unique index
 *     (→ `already_member`).
 *
 * Accepting does NOT revoke/expire the invite — the link stays reusable until it
 * expires or is revoked. Never logs the token.
 */
export async function acceptInvite({
	userId,
	userName,
	token,
	selection
}: {
	userId: string;
	userName: string;
	token: string;
	selection: AcceptSelection;
}): Promise<AcceptResult> {
	return db.transaction(async (tx) => {
		// (1) Re-validate inside the tx — the link may have expired/been revoked
		// between the preview and this POST.
		const invite = await resolveValidInvite(token, tx);
		if (!invite) {
			return { status: 'invalid' };
		}

		// (2) One member per user per group (PLAN §6.2 Rules): if the user already
		// links a member here, the accept is a friendly no-op.
		const [existing] = await tx
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.groupId, invite.groupId), eq(members.userId, userId)))
			.limit(1);
		if (existing) {
			return { status: 'already_member', groupId: invite.groupId };
		}

		// (3) Claim an EXISTING slot: atomically link the EMPTY, ACTIVE slot. The
		// WHERE doubles as the lock (`user_id IS NULL` blocks a second claim) AND the
		// cross-group guard (`group_id = :groupId`). `returning` gives the row count.
		if (selection.mode === 'existing') {
			try {
				const claimed = await tx
					.update(members)
					.set({ userId })
					.where(
						and(
							eq(members.id, selection.memberId),
							eq(members.groupId, invite.groupId),
							isNull(members.userId),
							isNull(members.deactivatedAt)
						)
					)
					.returning({ id: members.id });

				if (claimed.length === 0) {
					// Already claimed, deactivated, cross-group, or vanished → single-use.
					return { status: 'slot_taken' };
				}

				// TODO(6.1): append audit_log row (action='accept', entity_type='member',
				// entity_id=selection.memberId) in this same transaction. Never log the token.
				return { status: 'accepted', groupId: invite.groupId, memberId: claimed[0].id };
			} catch (e) {
				// Race backstop: the partial unique index `(group_id, user_id)` rejects a
				// concurrent link for the same user (e.g. another slot) → already_member.
				if (isUniqueViolation(e)) {
					return { status: 'already_member', groupId: invite.groupId };
				}
				throw e;
			}
		}

		// (4) Join as a NEW member: create a member linked to this user, display
		// name defaulting to the accepting user's name (editable later — PLAN §6.2).
		try {
			const [created] = await tx
				.insert(members)
				.values({ groupId: invite.groupId, userId, displayName: userName })
				.returning({ id: members.id });

			// TODO(6.1): append audit_log row (action='add', entity_type='member',
			// entity_id=created.id; note invite acceptance) in this same transaction.
			// Never log the token.
			return { status: 'accepted', groupId: invite.groupId, memberId: created.id };
		} catch (e) {
			// Race backstop: the partial unique index `(group_id, user_id)` rejects a
			// concurrent second link for the same user → friendly `already_member`.
			if (isUniqueViolation(e)) {
				return { status: 'already_member', groupId: invite.groupId };
			}
			throw e;
		}
	});
}
