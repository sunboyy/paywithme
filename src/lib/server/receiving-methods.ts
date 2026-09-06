// Receiving-method service — the whole business logic for a user's receiving
// profile (issue #84; PLAN §17.1, §17.3, §17.5; ADR-0016).
//
// Two halves, with deliberately different rules:
//
//   OWNER OPERATIONS (`listOwn`, `create`, `update`, `remove`, `reorder`) are
//   scoped to the caller's own `user_id`. A row belonging to somebody else is
//   NOT FOUND — never a 403 — so probing ids can't reveal that a method exists
//   (the same "don't leak" rule as `GroupAccessError`, PLAN §12).
//
//   THE VIEWER OPERATION (`listForViewer`) is the security-critical one. A
//   profile is visible to any member of any group the two share (PLAN §17.3), and
//   that is DERIVED ON EVERY READ rather than stored — which is what makes
//   leaving a group revoke visibility with no extra code, and why there is no
//   grant, share or revoke anywhere in this module.
//
// ── NO audit_log ROW (ADR-0016) ──────────────────────────────────────────────
// A deliberate exception to CLAUDE.md's every-mutation rule. `audit_log` rows are
// GROUP-scoped and readable by every member of that group; a receiving method
// belongs to a USER, so there is no correct `group_id` to write, and fanning one
// out would broadcast "X changed their bank account" into every group they are
// in. Nothing here touches the ledger. `receiving-methods.test.ts` asserts the
// absence, so a well-meaning "fix" fails loudly instead of quietly leaking.
//
// `rail` + `details` are only ever validated through the rail registry
// (`./payout-rails`) — the database is never taught the shape of `details`.

import { and, asc, eq, exists, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from './db';
import { receivingMethod } from './db/receiving-schema';
import { groups, members } from './db/groups-schema';
import { parseRailDetails } from './payout-rails';
import type { z } from 'zod';

/** A stored receiving method, exactly as the table holds it. */
export type ReceivingMethod = typeof receivingMethod.$inferSelect;

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select'>;

/**
 * The method doesn't exist, OR it belongs to another user.
 *
 * The two are deliberately INDISTINGUISHABLE. Answering "403 — that's someone
 * else's" confirms the row exists and that its owner has a bank account on file;
 * a route layer maps `code === 'receiving_method_not_found'` to **404**.
 */
export class ReceivingMethodNotFoundError extends Error {
	readonly code = 'receiving_method_not_found' as const;
	constructor(message = 'Receiving method not found') {
		super(message);
		this.name = 'ReceivingMethodNotFoundError';
	}
}

/**
 * The submitted `(rail, details)` pair failed the registry gate — either an
 * unknown rail key or details the rail's own Zod schema rejects. A route layer
 * maps `code === 'invalid_receiving_method'` to **400** and renders `error`'s
 * issues (the rail's own messages) against the form fields.
 *
 * `error` is absent for `reason === 'unknown_rail'`: an unknown rail has no schema
 * to produce issues, and it can only come from a tampered submission — the picker
 * offers registry entries only.
 */
export class InvalidReceivingMethodError extends Error {
	readonly code = 'invalid_receiving_method' as const;
	constructor(
		readonly reason: 'unknown_rail' | 'invalid_details',
		readonly error?: z.ZodError
	) {
		super(
			reason === 'unknown_rail'
				? 'Unknown receiving-method rail'
				: 'Receiving-method details are invalid'
		);
		this.name = 'InvalidReceivingMethodError';
	}
}

/**
 * `reorder` was given an id set that is not EXACTLY the caller's current methods —
 * a missing id, an extra one, a duplicate, or a row that has been deleted since
 * the page was rendered.
 *
 * The whole reorder is rejected rather than partially applied: a half-applied
 * order silently promotes the wrong account to "preferred", which is the one
 * position the settle screen actually shows. A route layer maps `code ===
 * 'receiving_method_order_mismatch'` to **409 Conflict** — the remedy is to
 * reload the profile and try again.
 */
export class ReceivingMethodOrderMismatchError extends Error {
	readonly code = 'receiving_method_order_mismatch' as const;
	constructor(message = 'The submitted order does not match your current receiving methods') {
		super(message);
		this.name = 'ReceivingMethodOrderMismatchError';
	}
}

/**
 * Every read orders by `(position, id)`.
 *
 * `position` is the preference (PLAN §17.1: first = what the settle screen shows).
 * The `id` tie-break is what keeps a DUPLICATE position stable across reads
 * instead of leaving the row order to the planner — duplicates are permitted by
 * design (the `(user_id, position)` index is not unique; see `receiving-schema.ts`).
 */
const PROFILE_ORDER = [asc(receivingMethod.position), asc(receivingMethod.id)];

/** The owner's own receiving profile, in preference order (PLAN §17.1). */
export async function listOwn(
	userId: string,
	executor: DbExecutor = db
): Promise<ReceivingMethod[]> {
	return executor
		.select()
		.from(receivingMethod)
		.where(eq(receivingMethod.userId, userId))
		.orderBy(...PROFILE_ORDER);
}

/**
 * Add a method to the end of the caller's profile.
 *
 * `details` goes through the registry gate first and it is the PARSED value that
 * is stored — trimmed, and stripped of any key the rail's schema doesn't declare,
 * so a stray field can never ride along into the jsonb column.
 *
 * The new `position` is computed by a SUB-SELECT inside the INSERT rather than by
 * a read-then-write, so the value is read in the same statement that uses it. A
 * first method lands at 0. Under READ COMMITTED two concurrent adds can still
 * both see the same `max(position)` and land on the same number — which is only
 * an ambiguous order, never corrupt data (see {@link PROFILE_ORDER}), and any
 * reorder rewrites both.
 */
export async function create(
	userId: string,
	rail: string,
	details: unknown
): Promise<ReceivingMethod> {
	const parsed = parseRailDetails(rail, details);
	if (!parsed.success) {
		throw new InvalidReceivingMethodError(
			parsed.reason,
			parsed.reason === 'invalid_details' ? parsed.error : undefined
		);
	}

	const [row] = await db
		.insert(receivingMethod)
		.values({
			userId,
			rail: parsed.rail,
			details: parsed.details,
			position: sql`(select coalesce(max(${receivingMethod.position}), -1) + 1 from ${receivingMethod} where ${receivingMethod.userId} = ${userId})`
		})
		.returning();

	return row;
}

/**
 * Replace the details of one of the caller's own methods.
 *
 * THE RAIL DOES NOT CHANGE: it is read from the stored row and the submitted
 * details are re-validated against that rail's schema. Switching rails would mean
 * every field on the form is replaced, which is a delete plus an add — modelling
 * it as an "edit" is what would let a `th_promptpay` payload land in a row still
 * labelled `th_bank_account`.
 *
 * Another user's row is NOT FOUND (see {@link ReceivingMethodNotFoundError}), and
 * the ownership predicate is repeated on the UPDATE itself, so the write is scoped
 * even though a read already checked.
 */
export async function update(
	userId: string,
	id: string,
	details: unknown
): Promise<ReceivingMethod> {
	const existing = await findOwn(userId, id);

	const parsed = parseRailDetails(existing.rail, details);
	if (!parsed.success) {
		throw new InvalidReceivingMethodError(
			parsed.reason,
			parsed.reason === 'invalid_details' ? parsed.error : undefined
		);
	}

	const [row] = await db
		.update(receivingMethod)
		.set({ details: parsed.details })
		.where(and(eq(receivingMethod.id, id), eq(receivingMethod.userId, userId)))
		.returning();

	// Deleted between the read and the write (another tab) — same not-found answer.
	if (!row) throw new ReceivingMethodNotFoundError();
	return row;
}

/**
 * Delete one of the caller's own methods — a HARD delete.
 *
 * Nothing references a receiving method: a settle-up transaction does not record
 * which one was used (PLAN §17.5), so there is no history to preserve, no
 * soft-delete flag, and no dangling row to reason about. Deleting is also the only
 * "off switch" the feature needs (PLAN §17.3).
 */
export async function remove(userId: string, id: string): Promise<ReceivingMethod> {
	const [row] = await db
		.delete(receivingMethod)
		.where(and(eq(receivingMethod.id, id), eq(receivingMethod.userId, userId)))
		.returning();

	if (!row) throw new ReceivingMethodNotFoundError();
	return row;
}

/**
 * Rewrite the whole profile order, in ONE transaction.
 *
 * `orderedIds` must be EXACTLY the caller's current methods — same ids, no
 * duplicates, none missing, none extra — or nothing is written at all
 * ({@link ReceivingMethodOrderMismatchError}). Positions become the array indices,
 * so the first id is the preferred method.
 *
 * The current ids are read `FOR UPDATE` inside the transaction, so a concurrent
 * `remove` or `update` of one of these rows waits rather than moving the set out
 * from under the check. A concurrent `create` locks nothing (there is no row yet)
 * and can commit alongside this, leaving the new method at whatever position it
 * was given — again an ambiguous order, not corrupt data, and the next reorder
 * fixes it.
 */
export async function reorder(userId: string, orderedIds: string[]): Promise<ReceivingMethod[]> {
	return db.transaction(async (tx) => {
		const current = await tx
			.select({ id: receivingMethod.id })
			.from(receivingMethod)
			.where(eq(receivingMethod.userId, userId))
			.for('update');

		assertSameIds(
			current.map((row) => row.id),
			orderedIds
		);

		for (const [position, id] of orderedIds.entries()) {
			await tx
				.update(receivingMethod)
				.set({ position })
				.where(and(eq(receivingMethod.id, id), eq(receivingMethod.userId, userId)));
		}

		return listOwn(userId, tx);
	});
}

/**
 * The target's receiving profile, as seen by another user — visible ONLY when the
 * two share a group (PLAN §17.3). No shared group means an empty list, which is
 * also what a co-member with no methods returns: a viewer cannot tell the two
 * apart, and the surfaces (§17.4) pick their empty state from the MEMBER they are
 * already looking at, not from this result.
 *
 * Visibility is recomputed here on every read and never stored, so leaving a group
 * revokes it with no extra code.
 *
 * Two ASYMMETRIES, both falling out of PLAN §6.3:
 *
 *   - The VIEWER's member row must be ACTIVE. Deactivating a member removes that
 *     user's access to the group entirely, so it takes this with it.
 *   - The TARGET's member row may be DEACTIVATED. Deactivation does not clear
 *     outstanding balances and the settle screen still shows what a departed
 *     member is owed — so you must still be able to pay them.
 *
 * A soft-deleted group grants nothing either way, matching `userHasGroupAccess`.
 *
 * Self-reads are not special-cased: a user who is an active member anywhere shares
 * that group with themselves and sees their own profile. Owners should call
 * {@link listOwn}, which needs no group at all.
 */
export async function listForViewer(
	viewerUserId: string,
	targetUserId: string
): Promise<ReceivingMethod[]> {
	const viewerMember = alias(members, 'viewer_member');
	const targetMember = alias(members, 'target_member');

	const shareAGroup = exists(
		db
			.select({ id: viewerMember.id })
			.from(viewerMember)
			.innerJoin(targetMember, eq(targetMember.groupId, viewerMember.groupId))
			.innerJoin(groups, eq(groups.id, viewerMember.groupId))
			.where(
				and(
					eq(viewerMember.userId, viewerUserId),
					isNull(viewerMember.deactivatedAt),
					eq(targetMember.userId, targetUserId),
					isNull(groups.deletedAt)
				)
			)
	);

	return db
		.select()
		.from(receivingMethod)
		.where(and(eq(receivingMethod.userId, targetUserId), shareAGroup))
		.orderBy(...PROFILE_ORDER);
}

/** One of the caller's OWN methods, or `ReceivingMethodNotFoundError`. */
async function findOwn(userId: string, id: string): Promise<ReceivingMethod> {
	const [row] = await db
		.select()
		.from(receivingMethod)
		.where(and(eq(receivingMethod.id, id), eq(receivingMethod.userId, userId)))
		.limit(1);

	if (!row) throw new ReceivingMethodNotFoundError();
	return row;
}

/** Throw unless `submitted` is a duplicate-free permutation of `current`. */
function assertSameIds(current: string[], submitted: string[]): void {
	const unique = new Set(submitted);
	if (unique.size !== submitted.length || unique.size !== current.length) {
		throw new ReceivingMethodOrderMismatchError();
	}
	for (const id of current) {
		if (!unique.has(id)) throw new ReceivingMethodOrderMismatchError();
	}
}
