// Group service — the testable business logic for group CRUD (PLAN §6.1, §6.4,
// §12). CLAUDE.md: "Business logic in lib/server/".
//
// This is the SERVER-SIDE SERVICE LAYER only — NOT routes/pages. The dashboard
// (`/groups`) and create page (`/groups/new`) are task 3.4; member management is
// 3.5; centralized access enforcement is 3.8 (which will build around the
// `userHasGroupAccess` primitive defined here).
//
// AUTHORIZATION (PLAN §12): "Authorization is group-membership based only … the
// single enforced check is that the requesting user has access to the group via
// a linked member. Enforce in lib/server." Every function below takes the acting
// `userId` and gates on an ACTIVE (non-`deactivated_at`) member link in a
// non-soft-deleted group. There are no per-action roles.
//
// ERROR MODEL: the mutations/reads throw small typed errors so the future route
// layer (3.4+) can map them deterministically to HTTP status codes:
//   - `GroupAccessError`   → 404 (we surface "no access" as not-found so we don't
//                            leak the existence of groups the user can't see —
//                            soft-deleted and access-denied are indistinguishable
//                            to the caller, matching PLAN §6.4 "routes return
//                            not-found").
//   - `CurrencyLockedError`→ 409 Conflict (the settlement currency is locked
//                            after the first transaction — §6.4).
// Both carry a stable `code` discriminator so callers can branch without string
// matching.
//
// AUDIT LOG — DEFERRED (do NOT build here): the `audit_log` table (task 4.2) and
// the same-transaction write helper (task 4.6) don't exist yet; group / member /
// invite audit writes are retrofitted in task 6.1. Per PLAN §12.1 every mutation
// must eventually append an immutable `audit_log` row in the SAME DB transaction,
// so each mutation below already runs inside `db.transaction(...)` and carries a
// `TODO(6.1)` at the exact insert site, making the retrofit mechanical.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { groups, members } from './db/groups-schema';
import { currencyCodeSchema } from '$lib/schemas/currency';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>;

/**
 * Access denied OR group not found / soft-deleted — deliberately conflated so we
 * never reveal that a group the user can't access exists (PLAN §12 "don't leak").
 * The route layer (3.4+) maps `code === 'group_access'` to **404**.
 */
export class GroupAccessError extends Error {
	readonly code = 'group_access' as const;
	constructor(message = 'Group not found') {
		super(message);
		this.name = 'GroupAccessError';
	}
}

/**
 * The group's settlement currency is locked because it already has at least one
 * transaction (PLAN §6.4 — changing it would invalidate stored settlement totals
 * and per-transaction rates). The route layer (3.4+) maps `code ===
 * 'currency_locked'` to **409 Conflict**.
 */
export class CurrencyLockedError extends Error {
	readonly code = 'currency_locked' as const;
	constructor(message = 'Settlement currency is locked after the first transaction') {
		super(message);
		this.name = 'CurrencyLockedError';
	}
}

/**
 * PURE access decision used by the read + mutation paths. Returns whether
 * `userId` has an ACTIVE member link (`members.user_id = userId` AND
 * `deactivated_at IS NULL`) in a NON-soft-deleted group (`groups.deleted_at IS
 * NULL`). This is the single membership check PLAN §12 mandates; task 3.8 will
 * centralize route enforcement around it.
 *
 * Accepts an optional executor so it composes inside a transaction (the
 * mutations assert access on the same connection they then write on).
 */
export async function userHasGroupAccess(
	userId: string,
	groupId: string,
	executor: DbExecutor = db
): Promise<boolean> {
	const rows = await executor
		.select({ id: members.id })
		.from(members)
		.innerJoin(groups, eq(members.groupId, groups.id))
		.where(
			and(
				eq(members.groupId, groupId),
				eq(members.userId, userId),
				isNull(members.deactivatedAt),
				isNull(groups.deletedAt)
			)
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * Assert access or throw `GroupAccessError` (→ 404). Used by every mutation /
 * access-checked read so "no access" and "doesn't exist / soft-deleted" are a
 * single indistinguishable outcome to the caller.
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

/**
 * Does this group already have at least one transaction? The transactions table
 * is Phase 4 (task 4.2) and does NOT exist yet, so this currently always returns
 * `false`. Wiring it later is a one-line change.
 */
async function groupHasTransactions(groupId: string, executor: DbExecutor = db): Promise<boolean> {
	// TODO(4.2): query transactions count once that table exists, e.g.
	//   const rows = await executor
	//     .select({ id: transactions.id })
	//     .from(transactions)
	//     .where(eq(transactions.groupId, groupId))
	//     .limit(1);
	//   return rows.length > 0;
	void groupId;
	void executor;
	return false;
}

/**
 * PURE settlement-currency lock decision (PLAN §6.4), unit-tested directly so the
 * rule is real and verified even though no transaction can exist yet. Throws
 * `CurrencyLockedError` when the group already has a transaction; otherwise
 * returns normally (the currency is still editable).
 */
export function assertSettlementCurrencyEditable(hasTransactions: boolean): void {
	if (hasTransactions) {
		throw new CurrencyLockedError();
	}
}

/** A group row as returned by the service. */
export type Group = typeof groups.$inferSelect;

/**
 * Create a group AND its creator's member slot in a single transaction.
 *
 * Per PLAN §6.1 access is granted ONLY via a linked member, so the creator-member
 * insert is REQUIRED — without it the creator couldn't access the group they just
 * made. Both inserts run in one `db.transaction(...)` so the group never exists
 * without its creator member (and so the 6.1 audit row can join them later).
 *
 * Returns the created group (including its generated id).
 */
export async function createGroup({
	userId,
	userName,
	name,
	settlementCurrency
}: {
	userId: string;
	userName: string;
	name: string;
	settlementCurrency: string;
}): Promise<Group> {
	// Validate the currency code at the service boundary too (defense in depth —
	// the route also validates via `createGroupSchema`). Throws ZodError on a bad
	// code, which the route maps to a 400.
	const currency = currencyCodeSchema.parse(settlementCurrency);

	return db.transaction(async (tx) => {
		const [group] = await tx
			.insert(groups)
			.values({ name, settlementCurrency: currency, createdBy: userId })
			.returning();

		// REQUIRED creator-member link (PLAN §6.1): the source of truth for the
		// creator's own access to the group. `display_name` defaults to the user's
		// name (editable later in member management, task 3.5).
		await tx.insert(members).values({
			groupId: group.id,
			userId,
			displayName: userName
		});

		// TODO(6.1): append audit_log row (action='create', entity_type='group') in
		// this same transaction.
		return group;
	});
}

/**
 * Rename a group (PLAN §6.4 — rename is ALWAYS allowed). Asserts access first;
 * not-found (`GroupAccessError`) if the group is soft-deleted or the user has no
 * access. Returns the updated group.
 */
export async function renameGroup({
	userId,
	groupId,
	name
}: {
	userId: string;
	groupId: string;
	name: string;
}): Promise<Group> {
	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		const [updated] = await tx
			.update(groups)
			.set({ name })
			.where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
			.returning();

		// `assertGroupAccess` already guaranteed a live, accessible group, so a
		// missing row here would be a concurrent soft-delete — surface as not-found.
		if (!updated) {
			throw new GroupAccessError();
		}

		// TODO(6.1): append audit_log row (action='rename', entity_type='group') in
		// this same transaction.
		return updated;
	});
}

/**
 * Soft-delete a group (PLAN §6.4): set `deleted_at = now()`. The group is then
 * hidden from every list and its routes return not-found, but the data is
 * retained and recoverable (no hard-delete in v1). Asserts access. Idempotent:
 * re-deleting an already-deleted group is a friendly no-op (the access check has
 * already failed for it, so this path is reached only for live groups).
 */
export async function softDeleteGroup({
	userId,
	groupId
}: {
	userId: string;
	groupId: string;
}): Promise<void> {
	await db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		// Only stamp `deleted_at` if it's still null → idempotent (a no-op on an
		// already soft-deleted group rather than overwriting the original delete
		// time). Access already failed above for a deleted group, so in practice
		// this targets a live group; the `isNull` guard keeps it safe under races.
		await tx
			.update(groups)
			.set({ deletedAt: new Date() })
			.where(and(eq(groups.id, groupId), isNull(groups.deletedAt)));

		// TODO(6.1): append audit_log row (action='delete', entity_type='group') in
		// this same transaction.
	});
}

/**
 * Update a group's settlement currency (PLAN §6.4). Asserts access, validates the
 * code via `currencyCodeSchema`, then ENFORCES THE LOCK: allowed only while the
 * group has NO transactions. After the first transaction it throws
 * `CurrencyLockedError` (→ 409). Returns the updated group.
 */
export async function updateSettlementCurrency({
	userId,
	groupId,
	settlementCurrency
}: {
	userId: string;
	groupId: string;
	settlementCurrency: string;
}): Promise<Group> {
	// Validate the code first (throws ZodError → 400 at the route). No re-listing
	// of currencies — the shared schema is the single gate (§7.5.1).
	const currency = currencyCodeSchema.parse(settlementCurrency);

	return db.transaction(async (tx) => {
		await assertGroupAccess(userId, groupId, tx);

		// Enforce the lock via the PURE decision against the (deferred) tx-count.
		assertSettlementCurrencyEditable(await groupHasTransactions(groupId, tx));

		const [updated] = await tx
			.update(groups)
			.set({ settlementCurrency: currency })
			.where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
			.returning();

		if (!updated) {
			throw new GroupAccessError();
		}

		// TODO(6.1): append audit_log row (action='currency_set', entity_type='group')
		// in this same transaction.
		return updated;
	});
}

/**
 * List the groups `userId` can access (PLAN §6.4 read side — task 3.4's dashboard
 * consumes this): groups where the user has an ACTIVE (non-`deactivated_at`)
 * member link and the group is NOT soft-deleted. Newest first.
 */
export async function listGroupsForUser(userId: string): Promise<Group[]> {
	return db
		.select({
			id: groups.id,
			name: groups.name,
			settlementCurrency: groups.settlementCurrency,
			createdBy: groups.createdBy,
			createdAt: groups.createdAt,
			deletedAt: groups.deletedAt
		})
		.from(groups)
		.innerJoin(members, eq(members.groupId, groups.id))
		.where(and(eq(members.userId, userId), isNull(members.deactivatedAt), isNull(groups.deletedAt)))
		.orderBy(desc(groups.createdAt));
}

/**
 * Access-checked fetch of a single group (PLAN §6.4). Returns the group when
 * `userId` has access and it isn't soft-deleted; returns `null` to signal
 * not-found otherwise (route layer → 404). Read counterpart to the mutations'
 * `assertGroupAccess`.
 */
export async function getGroupForUser(userId: string, groupId: string): Promise<Group | null> {
	if (!(await userHasGroupAccess(userId, groupId))) {
		return null;
	}

	const [group] = await db
		.select()
		.from(groups)
		.where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
		.limit(1);

	return group ?? null;
}
