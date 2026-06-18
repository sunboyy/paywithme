// Member service — the testable business logic for member management (PLAN §6.1,
// §6.2 display-name edit, §6.3 lifecycle). CLAUDE.md: "Business logic in
// lib/server/".
//
// This is the SERVER-SIDE SERVICE LAYER only — NOT routes/pages. The members
// page (`/groups/[id]/members`) is the route half of task 3.5. Invite links
// (create/copy/revoke) are task 3.6 and are NOT built here. Centralized route
// access enforcement is task 3.8, which will build around the same membership
// primitive these functions reuse.
//
// AUTHORIZATION (PLAN §12): "Authorization is group-membership based only … the
// single enforced check is that the requesting user has access to the group via
// a linked member." Every function below takes the acting `userId` and gates on
// `assertGroupAccess` (the task-3.3 primitive). Mutations that target a specific
// member ALSO verify that member belongs to `groupId` (never act cross-group).
//
// ERROR MODEL (consistent with the 3.3 group service):
//   - `GroupAccessError` (reused from `./groups`) → 404: no access / group not
//     found / soft-deleted — deliberately conflated so we never leak existence.
//   - `MemberNotFoundError` (defined here)         → 404: the target member does
//     not exist in this group (or was hard-deleted). Same not-found outcome, but
//     a distinct `code` so the route layer can branch without string matching.
//
// AUDIT LOG (task 6.1 — DONE): per PLAN §12.1 every mutation appends an immutable
// `audit_log` row in the SAME DB transaction as the mutation. Each mutation below
// runs inside `db.transaction(...)` and calls `writeAuditLog(tx, …)` through that
// SAME `tx` handle (never the global `db`), so the audit row commits/rolls back
// atomically with the change. The hard-delete branch of `removeMember` is the one
// exception (a zero-activity cleanup with no ledger history) — see there.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { members } from './db/groups-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { writeAuditLog } from './audit';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * The target member does not exist in this group (never created, in another
 * group, or already hard-deleted). The route layer maps `code ===
 * 'member_not_found'` to **404**, mirroring the `GroupAccessError` not-found
 * outcome (we never act on a member outside the asserted group).
 */
export class MemberNotFoundError extends Error {
	readonly code = 'member_not_found' as const;
	constructor(message = 'Member not found') {
		super(message);
		this.name = 'MemberNotFoundError';
	}
}

/**
 * Assert access or throw `GroupAccessError` (→ 404). Thin wrapper over the 3.3
 * primitive so "no access" / "soft-deleted group" is a single not-found outcome.
 */
async function assertGroupAccess(
	userId: string,
	groupId: string,
	executor: DbExecutor = db
): Promise<void> {
	if (!(await userHasGroupAccess(userId, groupId, executor))) {
		throw new GroupAccessError();
	}
}

/** A raw member row as stored. */
export type Member = typeof members.$inferSelect;

/** The member shape the members page renders (PLAN §6.3 — marks inactive/linked). */
export type MemberListItem = {
	id: string;
	displayName: string;
	/** The linked better-auth user id, or null for an unlinked participant slot. */
	userId: string | null;
	/** ISO string (or null) — non-null means soft-deactivated (§6.3). */
	deactivatedAt: string | null;
	/** Convenience flag for the UI: the slot maps to a real account. */
	isLinked: boolean;
};

/**
 * Load a member row scoped to `groupId`, or throw `MemberNotFoundError`. This is
 * the cross-group guard: a member id is only ever acted on after confirming it
 * belongs to the group whose access was just asserted (PLAN §12 — never act
 * cross-group). Runs on the passed executor so it shares the mutation's tx.
 */
async function getGroupMemberOrThrow(
	groupId: string,
	memberId: string,
	executor: DbExecutor = db
): Promise<Member> {
	const [row] = await executor
		.select()
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
		.limit(1);

	if (!row) {
		throw new MemberNotFoundError();
	}
	return row;
}

/**
 * Does this member have any ledger activity (a payer/share row in any
 * transaction)? The transaction payer/share tables are Phase 4 (task 4.2) and do
 * NOT exist yet, so this currently always returns `false`. Wiring it later is a
 * one-line change.
 */
async function memberHasActivity(memberId: string, executor: DbExecutor = db): Promise<boolean> {
	// TODO(4.2): true if any transaction_payers/transaction_shares row references
	// this member, e.g.
	//   const rows = await executor
	//     .select({ id: transactionShares.id })
	//     .from(transactionShares)
	//     .where(eq(transactionShares.memberId, memberId))
	//     .limit(1);
	//   return rows.length > 0;   // (union with transaction_payers)
	void memberId;
	void executor;
	return false;
}

/**
 * PURE removal-branch decision (PLAN §6.3), unit-tested directly so the rule is
 * real and verified even though no activity can exist yet. A member with ANY
 * activity is SOFT-DEACTIVATED (kept in the ledger); a member with ZERO activity
 * may be HARD-DELETED (cleanup of a mistyped slot).
 */
export function decideMemberRemoval(hasActivity: boolean): 'soft_deactivate' | 'hard_delete' {
	return hasActivity ? 'soft_deactivate' : 'hard_delete';
}

/**
 * List ALL members of a group, including deactivated ones (PLAN §6.3 — the page
 * marks inactive members; they stay in the ledger). Access-checked. Ordered
 * sensibly: ACTIVE members first, then by display name (case-insensitive-ish via
 * the column collation), so the management list is stable and readable.
 */
export async function listMembers({
	userId,
	groupId
}: {
	userId: string;
	groupId: string;
}): Promise<MemberListItem[]> {
	await assertGroupAccess(userId, groupId);

	const rows = await db
		.select()
		.from(members)
		.where(eq(members.groupId, groupId))
		// Active first (NULLS — Postgres sorts NULLs last by default under ASC, so
		// active `deactivated_at IS NULL` rows come after non-null; flip to get
		// active first). Using `asc` on display name as the secondary key keeps the
		// list stable; the active/inactive split is finalized in JS below to keep
		// the ordering portable across drivers.
		.orderBy(asc(members.displayName));

	return rows
		.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			userId: m.userId ?? null,
			deactivatedAt: m.deactivatedAt ? m.deactivatedAt.toISOString() : null,
			isLinked: m.userId != null
		}))
		.sort((a, b) => {
			// Active (deactivatedAt null) before inactive; then by display name.
			const aInactive = a.deactivatedAt != null ? 1 : 0;
			const bInactive = b.deactivatedAt != null ? 1 : 0;
			if (aInactive !== bInactive) return aInactive - bInactive;
			return a.displayName.localeCompare(b.displayName);
		});
}

/**
 * Add a NEW UNLINKED member to a group (PLAN §6.1 — a participant slot for
 * someone who may not have an account). Access-checked. `user_id` is left null;
 * linking to a real user happens only via invite accept (task 3.6/3.7). Returns
 * the created member. Runs in a transaction so the 6.1 audit row can join it.
 */
export async function addMember({
	userId,
	groupId,
	displayName
}: {
	userId: string;
	groupId: string;
	displayName: string;
}): Promise<Member> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		const [member] = await tx
			.insert(members)
			.values({
				groupId,
				displayName,
				// Explicitly unlinked — a participant slot, not a user link (§6.1).
				userId: null
			})
			.returning();

		// Audit row — IN THE SAME TRANSACTION (PLAN §12.1).
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'add',
			entityType: 'member',
			entityId: member.id,
			summary: `Added member '${member.displayName}'`,
			metadata: { displayName: member.displayName }
		});
		return member;
	});
}

/**
 * Rename a member (PLAN §6.2 — display name is editable in member management).
 * Access-checked + verifies the member belongs to `groupId` before updating.
 * Returns the updated member.
 */
export async function renameMember({
	userId,
	groupId,
	memberId,
	displayName
}: {
	userId: string;
	groupId: string;
	memberId: string;
	displayName: string;
}): Promise<Member> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		// Cross-group guard: confirm the slot is in THIS group before touching it.
		// Capture the OLD name (already loaded here) for a before/after audit snapshot.
		const before = await getGroupMemberOrThrow(groupId, memberId, tx);

		const [updated] = await tx
			.update(members)
			.set({ displayName })
			.where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
			.returning();

		if (!updated) {
			// A concurrent hard-delete between the check and the update — surface as
			// not-found rather than returning undefined.
			throw new MemberNotFoundError();
		}

		// Audit row — IN THE SAME TRANSACTION (PLAN §12.1). before/after from values
		// already in scope (no extra read).
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'rename',
			entityType: 'member',
			entityId: memberId,
			summary: `Renamed member to '${updated.displayName}'`,
			metadata: { from: before.displayName, to: updated.displayName }
		});
		return updated;
	});
}

/** The outcome of `removeMember`, so callers/tests can assert which branch ran. */
export type RemoveMemberResult = { action: 'soft_deactivate' | 'hard_delete' };

/**
 * Remove a member (PLAN §6.3). Access-checked + cross-group verified. Branches on
 * activity via the PURE `decideMemberRemoval(await memberHasActivity(...))`:
 *   - ANY activity → SOFT-DEACTIVATE: stamp `deactivated_at = now()`. The member
 *     stays in past transactions / balance math; they just disappear from new-tx
 *     pickers and are marked inactive in lists.
 *   - ZERO activity → HARD-DELETE: a mistyped slot with no ledger history is
 *     safe to physically remove (cleanup).
 *
 * ACCESS REVOCATION (PLAN §6.3): soft-deactivating a LINKED member removes that
 * user's access to the group "naturally" — `deactivated_at` is set, and the 3.3
 * access primitive (`userHasGroupAccess`) already filters on
 * `isNull(deactivatedAt)`, so the deactivated link no longer grants access. No
 * extra code is needed here.
 *
 * The activity check is INJECTABLE (defaulting to the real `memberHasActivity`),
 * matching the codebase's optional-`executor` idiom — production callers are
 * unchanged, but both removal branches are testable now and task 4.2 can pass
 * the real transactions-backed predicate without touching this signature.
 */
export async function removeMember(
	{
		userId,
		groupId,
		memberId
	}: {
		userId: string;
		groupId: string;
		memberId: string;
	},
	// Seam: the activity check is injectable so both removal branches are testable
	// now and 4.2 can pass the real transactions-backed predicate. Defaults to the
	// (currently deferred) module-private `memberHasActivity`.
	hasActivity: (memberId: string) => Promise<boolean> = (id) => memberHasActivity(id, db)
): Promise<RemoveMemberResult> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		const target = await getGroupMemberOrThrow(groupId, memberId, tx);

		const decision = decideMemberRemoval(await hasActivity(memberId));

		if (decision === 'soft_deactivate') {
			// Soft-deactivate: keep the ledger intact. Idempotent via the `isNull`
			// guard (re-deactivating doesn't overwrite the original time). This is
			// also what revokes a linked user's access (see doc above).
			await tx
				.update(members)
				.set({ deactivatedAt: new Date() })
				.where(
					and(eq(members.id, memberId), eq(members.groupId, groupId), isNull(members.deactivatedAt))
				);

			// Audit row — IN THE SAME TRANSACTION (PLAN §12.1). Denormalize the name so
			// the line stays readable even after the slot later changes.
			await writeAuditLog(tx, {
				groupId,
				actorUserId: userId,
				action: 'deactivate',
				entityType: 'member',
				entityId: memberId,
				summary: `Deactivated member '${target.displayName}'`,
				metadata: { displayName: target.displayName }
			});
		} else {
			// Hard-delete: a zero-activity slot has no ledger history to preserve, so
			// physically remove it (mistyped-slot cleanup, §6.3). DELIBERATELY NOT
			// audited (task 6.1 decision): nothing meaningful happened in the ledger,
			// and a 'delete'/'member' entry would reference a row that no longer exists.
			await tx.delete(members).where(and(eq(members.id, memberId), eq(members.groupId, groupId)));
		}

		return { action: decision };
	});
}

/**
 * Reactivate a member (PLAN §6.3 — "Reactivation is a simple flag flip"). Clears
 * `deactivated_at`, restoring the slot (and, if linked, the user's access — the
 * access primitive re-admits them once `deactivated_at IS NULL`). Access-checked
 * + cross-group verified. Returns the updated member.
 */
export async function reactivateMember({
	userId,
	groupId,
	memberId
}: {
	userId: string;
	groupId: string;
	memberId: string;
}): Promise<Member> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		await getGroupMemberOrThrow(groupId, memberId, tx);

		const [updated] = await tx
			.update(members)
			.set({ deactivatedAt: null })
			.where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
			.returning();

		if (!updated) {
			throw new MemberNotFoundError();
		}

		// Audit row — IN THE SAME TRANSACTION (PLAN §12.1).
		await writeAuditLog(tx, {
			groupId,
			actorUserId: userId,
			action: 'reactivate',
			entityType: 'member',
			entityId: memberId,
			summary: `Reactivated member '${updated.displayName}'`,
			metadata: { displayName: updated.displayName }
		});
		return updated;
	});
}
