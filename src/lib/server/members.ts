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
//   - `DisplayNameTakenError` (defined here)       → 400 / form error: the name
//     collides with an ACTIVE member of the same group (ADR-0015). Self-correctable
//     — the message says what clashed and how to fix it.
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
import { transactionPayers, transactionShares } from './db/transactions-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { displayNameValues } from './member-name';
import { writeAuditLog } from './audit';
import { isUniqueViolation } from './db/pg-errors';

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

/** Which write ran into the collision — only the REMEDY differs between them. */
export type DisplayNameCollisionSource = 'add' | 'rename' | 'reactivate';

/**
 * The display name is already held by an ACTIVE member of this group
 * (`members_group_id_normalized_display_name_unique`; ADR-0015). A HARD REJECT for
 * all three admin actions — the plan's auto-suffix escape hatch belongs to
 * invite-accept, where the joiner did not choose the name, not here where an admin
 * typed it and can retype it.
 *
 * `source` picks the remedy the message states, which is the whole point of the
 * error (ADR-0009: an error is only self-correctable if it says how to correct it):
 *   - add / rename → the name in hand is the wrong one; pick another.
 *   - reactivate   → the name is NOT in hand (nothing in the request carries it),
 *     so "pick another" is not an instruction the admin can act on. The fix is the
 *     one the partial index leaves open: rename the DEACTIVATED member first — the
 *     constraint only covers `deactivated_at IS NULL`, so that rename always
 *     succeeds — then reactivate.
 *
 * The route layer maps `code === 'display_name_taken'` to a **400** form error.
 */
export class DisplayNameTakenError extends Error {
	readonly code = 'display_name_taken' as const;
	constructor(
		readonly groupId: string,
		readonly displayName: string,
		readonly source: DisplayNameCollisionSource
	) {
		super(
			source === 'reactivate'
				? `Another active member is already called '${displayName}', so this member can't be reactivated under that name. Rename the inactive member first, then reactivate them.`
				: `Another active member is already called '${displayName}'. Choose a different name.`
		);
		this.name = 'DisplayNameTakenError';
	}
}

/**
 * Was this write refused by the active-name uniqueness index? Every member write
 * below reaches exactly ONE unique index it can newly violate, so a plain SQLSTATE
 * 23505 is already unambiguous here and needs no index-name discrimination:
 *   - `addMember` inserts with `user_id = null`, which the partial
 *     `members_group_id_user_id_unique` (on `user_id IS NOT NULL`) does not cover.
 *   - `renameMember` writes only the two name columns, so it cannot newly violate a
 *     constraint over `user_id`.
 *   - `reactivateMember` writes only `deactivated_at`, and the user-id index is
 *     partial on `user_id IS NOT NULL` — NOT on the active flag — so a deactivated
 *     linked member already occupies its `(group_id, user_id)` slot and clearing
 *     the flag cannot collide there.
 * Invite-accept is the path that CAN trip either index (it inserts a linked row
 * with a name); it is issue #77's problem and deliberately not handled here.
 */
function isDisplayNameCollision(e: unknown): boolean {
	return isUniqueViolation(e);
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
 *
 * `lock: true` takes `FOR UPDATE` on the row — see {@link removeMember}, the one
 * caller that needs it. The default is unlocked: rename / reactivate only ever
 * write the member row itself, so they have no check-then-act window to close and
 * should not serialize against concurrent ledger writes.
 */
async function getGroupMemberOrThrow(
	groupId: string,
	memberId: string,
	executor: DbExecutor = db,
	lock = false
): Promise<Member> {
	const query = executor
		.select()
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
		.limit(1);

	const [row] = await (lock ? query.for('update') : query);

	if (!row) {
		throw new MemberNotFoundError();
	}
	return row;
}

/**
 * Does this member have any ledger activity — a payer row or a share row in ANY
 * transaction (PLAN §6.3)? This is what decides soft-deactivate vs hard-delete:
 * `members.id` is referenced with ON DELETE CASCADE from `transaction_payers`,
 * `transaction_shares` and `transaction_item_beneficiaries`, so hard-deleting a
 * member with activity would silently erase their rows from the ledger and shift
 * every other member's balance.
 *
 * SOFT-DELETED TRANSACTIONS COUNT. A soft-deleted transaction can be restored
 * (PLAN §9) and still stores this member's amounts, so we deliberately do NOT
 * join to `transactions` to filter on `deleted_at` — the same rule
 * `currency-usage.ts` applies to currency references.
 *
 * PAYERS ∪ SHARES IS COMPLETE. An itemized split aggregates every item
 * beneficiary into a per-member `transaction_shares` row
 * (`lib/transactions/resolve.ts`), so a member reachable via
 * `transaction_item_beneficiaries` always has a share row too. Two probes, not
 * three.
 *
 * Runs on the passed executor so it shares the caller's transaction.
 */
async function memberHasActivity(memberId: string, executor: DbExecutor = db): Promise<boolean> {
	const payerRows = await executor
		.select({ memberId: transactionPayers.memberId })
		.from(transactionPayers)
		.where(eq(transactionPayers.memberId, memberId))
		.limit(1);
	if (payerRows.length > 0) return true;

	const shareRows = await executor
		.select({ memberId: transactionShares.memberId })
		.from(transactionShares)
		.where(eq(transactionShares.memberId, memberId))
		.limit(1);
	return shareRows.length > 0;
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
 *
 * A name already held by an ACTIVE member is a hard reject
 * (`DisplayNameTakenError`; ADR-0015). There is deliberately NO pre-check read
 * before the insert: the index has to be the authority under a race anyway, and —
 * unlike `createCustomCurrency`, whose pre-check exists to distinguish a seeded
 * clash from a custom one — there is only one kind of clash here, so a pre-check
 * would buy an extra query and the identical message.
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

		let member: Member;
		try {
			[member] = await tx
				.insert(members)
				.values({
					groupId,
					// Writes the name AND its canonical key, which backs the active-member
					// uniqueness index (ADR-0015).
					...displayNameValues(displayName),
					// Explicitly unlinked — a participant slot, not a user link (§6.1).
					userId: null
				})
				.returning();
		} catch (e) {
			if (isDisplayNameCollision(e)) {
				throw new DisplayNameTakenError(groupId, displayName, 'add');
			}
			throw e;
		}

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

		let updated: Member;
		try {
			[updated] = await tx
				.update(members)
				// The canonical key moves WITH the name (ADR-0015) — a rename that left the
				// old key behind would silently disable the uniqueness index for this row.
				// Renaming a DEACTIVATED member still can't collide: the index is partial on
				// `deactivated_at IS NULL`, which is exactly what makes it the escape hatch
				// for a blocked reactivation (§6.3).
				.set(displayNameValues(displayName))
				.where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
				.returning();
		} catch (e) {
			// An ACTIVE member already holds the name (ADR-0015) — hard reject, same as
			// `addMember`: the admin has the name in hand and can pick another.
			if (isDisplayNameCollision(e)) {
				throw new DisplayNameTakenError(groupId, displayName, 'rename');
			}
			throw e;
		}

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
 * unchanged, but both removal branches are testable by injecting a stub.
 *
 * The predicate RECEIVES THE EXECUTOR rather than closing over one, so the real
 * check runs on the SAME `tx` as the delete it guards. Passing the global `db`
 * here would read the ledger OUTSIDE this transaction — an inconsistent read
 * against the access check and member lookup that precede it, and a doc comment
 * (`memberHasActivity`: "shares the caller's transaction") that would be false at
 * the only production call site.
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
	// with a stub. It takes the EXECUTOR as its second argument so the production
	// default runs inside the caller's transaction (see the note above); a test
	// stub can ignore it. Defaults to the module-private `memberHasActivity`.
	hasActivity: (memberId: string, executor: DbExecutor) => Promise<boolean> = memberHasActivity
): Promise<RemoveMemberResult> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);
		// LOCK THE MEMBER ROW BEFORE PROBING (`FOR UPDATE`). Without it this is a
		// check-then-act race with a concurrent `createTransaction`: the probes could
		// return empty, a create could commit payer/share rows for this member, and the
		// hard delete would then cascade those brand-new rows away — the exact silent
		// ledger loss this branch exists to prevent. Running the probes on `tx` narrows
		// nothing on its own; under READ COMMITTED each statement takes a fresh
		// snapshot, so a row committed after the probe is still invisible to it.
		//
		// `FOR UPDATE` closes it using the lock the FOREIGN KEY already takes: inserting
		// a `transaction_payers` / `transaction_shares` row acquires `FOR KEY SHARE` on
		// the `members` row it references, and `FOR UPDATE` CONFLICTS with `FOR KEY
		// SHARE`. So the two operations are mutually exclusive, both ways round:
		//   - we win the lock  → the create blocks; we probe (empty), hard-delete, and
		//     commit; the create then fails its FK, which is correct — you cannot record
		//     a transaction for a member that was just removed.
		//   - the create wins  → we block until it commits, and only THEN probe — so we
		//     see its rows and take the soft-deactivate branch.
		// Same mechanism as the issue #69 currency freeze (`transactions.ts`), which
		// reasons about these same FK-induced `FOR KEY SHARE` locks.
		//
		// Deadlock risk is negligible: this path locks exactly ONE member row, so it can
		// never be half of a lock cycle.
		const target = await getGroupMemberOrThrow(groupId, memberId, tx, true);

		const decision = decideMemberRemoval(await hasActivity(memberId, tx));

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
 *
 * NOT ACTUALLY A BARE FLAG FLIP any more (ADR-0015): clearing the flag re-enters
 * the active set, so it can trip
 * `members_group_id_normalized_display_name_unique` when an ACTIVE member has
 * since taken this member's name — a failure mode the flip never had before the
 * index existed. It is a hard reject with the remedy spelled out
 * (`DisplayNameTakenError`, `source: 'reactivate'`), and the whole transaction
 * rolls back, so a refused reactivation leaves the member deactivated rather than
 * half-restored.
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
		// The name the error has to report comes from THIS row: the request carries a
		// member id only, and the failed UPDATE returns nothing to name it with.
		const target = await getGroupMemberOrThrow(groupId, memberId, tx);

		let updated: Member;
		try {
			[updated] = await tx
				.update(members)
				.set({ deactivatedAt: null })
				.where(and(eq(members.id, memberId), eq(members.groupId, groupId)))
				.returning();
		} catch (e) {
			if (isDisplayNameCollision(e)) {
				throw new DisplayNameTakenError(groupId, target.displayName, 'reactivate');
			}
			throw e;
		}

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
