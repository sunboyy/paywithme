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
// ERROR MODEL (consistent with the 3.3/3.5 services) and HTTP MAPPING intent:
//   - `GroupAccessError` (reused from `./groups`)  → 404: no access / group not
//     found / soft-deleted — deliberately conflated so we never leak existence.
//   - `InviteNotFoundError` (defined here)         → 404: the target invite does
//     not exist in this group. Same not-found outcome, distinct `code`.
//   - `InviteTargetError` (defined here)           → 400/409: the targeted member
//     is not an eligible slot (not in the group, deactivated, or already linked).
//     A member-targeted invite only makes sense for an EMPTY, ACTIVE slot
//     (PLAN §6.2). The route layer maps this to a friendly 400/409.
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
import { invites, members } from './db/groups-schema';
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

/**
 * The targeted member is not an eligible slot for a member-targeted invite. A
 * member-targeted link only makes sense for an EMPTY, ACTIVE slot in this group
 * (PLAN §6.2): it must belong to the group, be NOT deactivated, and be UNLINKED
 * (`user_id IS NULL`). The route layer maps `code === 'invite_target'` to a
 * friendly **400** (bad target) / **409** (slot already claimed).
 */
export class InviteTargetError extends Error {
	readonly code = 'invite_target' as const;
	constructor(message = 'That member can’t be invited to this slot') {
		super(message);
		this.name = 'InviteTargetError';
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
	memberId: string | null;
	expiresAt: Date;
	createdAt: Date;
};

/** The active-invite shape the management list renders (PLAN §6.2). */
export type ActiveInvite = {
	id: string;
	token: string;
	memberId: string | null;
	expiresAt: string;
	createdAt: string;
};

/**
 * Validate that `memberId` is an eligible target slot for a member-targeted
 * invite (PLAN §6.2): belongs to `groupId`, is NOT deactivated, and is UNLINKED
 * (`user_id IS NULL`). Throws `InviteTargetError` otherwise. Runs on the passed
 * executor so it shares the mutation's transaction.
 */
async function assertEligibleTargetMember(
	groupId: string,
	memberId: string,
	executor: DbExecutor
): Promise<void> {
	const [row] = await executor
		.select({
			id: members.id,
			userId: members.userId,
			deactivatedAt: members.deactivatedAt
		})
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
		.limit(1);

	// Not in this group (or hard-deleted) → not an eligible target.
	if (!row) {
		throw new InviteTargetError('That member is not part of this group.');
	}
	// Already linked to a user → the slot is filled; nothing to invite into.
	if (row.userId != null) {
		throw new InviteTargetError('That member is already linked to a user.');
	}
	// Deactivated → hidden from new activity; not a valid invite target (§6.3).
	if (row.deactivatedAt != null) {
		throw new InviteTargetError('That member is inactive.');
	}
}

/**
 * Create an invite link for a group (PLAN §6.2). Access-checked. The link is
 * REUSABLE with a 7-day expiry; a group may have MULTIPLE active links at once.
 *
 * `memberId` (optional / `null`) targets a specific UNLINKED member slot to fill;
 * omitted/null = an OPEN invite (accept creates a new member in 3.7). When a
 * target is given it's validated as eligible (in-group, active, unlinked) — else
 * `InviteTargetError`.
 *
 * Generates an unguessable token (`randomBytes(32).base64url`), sets
 * `expiresAt = now + INVITE_TTL_DAYS days`, and inserts inside a transaction.
 * Returns the created invite (incl. token + expiresAt + memberId). NEVER logs the
 * token.
 */
export async function createInvite({
	userId,
	groupId,
	memberId = null
}: {
	userId: string;
	groupId: string;
	memberId?: string | null;
}): Promise<CreatedInvite> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		// A member-targeted invite only makes sense for an empty, active slot.
		if (memberId != null) {
			await assertEligibleTargetMember(groupId, memberId, tx);
		}

		const [invite] = await tx
			.insert(invites)
			.values({
				groupId,
				token: generateInviteToken(),
				memberId, // null = open invite
				expiresAt: inviteExpiresAt(),
				createdBy: userId
			})
			.returning();

		// TODO(6.1): append audit_log row (action='create', entity_type='invite') in
		// this same transaction. Do NOT include the raw token in the audit summary.
		return {
			id: invite.id,
			token: invite.token,
			memberId: invite.memberId ?? null,
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
			memberId: invites.memberId,
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
		memberId: r.memberId ?? null,
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
