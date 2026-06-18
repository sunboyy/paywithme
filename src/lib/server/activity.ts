// Group activity feed service — the §12.1 group-level audit-log READ (task 6.2).
// CLAUDE.md: "Business logic in lib/server/".
//
// This is the READ side of the audit trail. The WRITE side (an `audit_log` row in
// the SAME DB transaction as every mutation) is task 6.1 and lives in
// `audit.ts` / each service. The per-transaction history view (entries filtered to
// one `entity_id`) is the SEPARATE task 6.3 — NOT here.
//
// ── What it reads (PLAN §12.1 Visibility) ─────────────────────────────────────
// The group's `audit_log` rows, `group_id = groupId` ONLY (never another group's),
// sorted by `occurred_at` DESC (newest first) — which is exactly the existing
// `audit_log_group_id_occurred_at_idx` (group_id, occurred_at DESC) index.
//
// ── Actor name resolution (PLAN §12.1) ────────────────────────────────────────
// "resolve to their member's name in that group, else the user's name". So we LEFT
// JOIN `members` on (user_id = actor_user_id AND group_id = groupId) and take that
// member's `display_name`; when there's no member slot in this group (e.g. an actor
// whose member was hard-deleted) we fall back to the better-auth `user.name`. The
// actor is NOT NULL in the schema so a row always resolves to SOMETHING; the final
// "Someone" fallback only guards the (schema-impossible) all-null case so the feed
// never crashes.
//
// ── Optional filters (PLAN §12.1 "optional filters by entity type or member") ──
//   - entityType — one of AUDIT_ENTITY_TYPES; an unrecognized value is treated as
//     "no filter" (mirrors how the transactions list's parseTypeFilter ignores junk).
//   - actorUserId — actions performed BY one user. This is the "by member" filter
//     expressed via the DURABLE actor key. Filtering by the member *acted upon* is
//     ambiguous (entity_id spans transaction|member|invite|group and may dangle), so
//     we filter by ACTOR, which is well-defined and durable.

import { and, desc, eq } from 'drizzle-orm';
import { db } from './db';
import { auditLog } from './db/audit-schema';
import { members } from './db/groups-schema';
import { user } from './db/auth-schema';
import { GroupAccessError, userHasGroupAccess } from './groups';
import { AUDIT_ENTITY_TYPES, type AuditEntityType } from './audit';

/** A query runner: either the lazy `db` proxy or an open transaction handle. */
type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * Max rows returned by the feed, newest-first. A bounded payload so the feed can't
 * grow unboundedly with a group's history. Pagination is out of scope for v1
 * (PLAN §12.1) — this is a simple safety cap.
 */
export const ACTIVITY_LIMIT = 200;

/** Generic actor label when even the user name is somehow null (never crash). */
const UNKNOWN_ACTOR = 'Someone';

/** One serializable activity-feed row (timestamps stringified at the boundary). */
export type ActivityEntry = {
	id: string;
	action: string;
	entityType: string;
	entityId: string;
	summary: string;
	metadata: unknown;
	/** ISO string — the route/page renders locale time client-side. */
	occurredAt: string;
	/** Durable authorship key (PLAN §12.1). */
	actorUserId: string;
	/** Resolved member display name in this group, else user name, else "Someone". */
	actorName: string;
};

/** Optional feed filters (PLAN §12.1 — by entity type or by actor/member). */
export type ActivityFilters = {
	entityType?: AuditEntityType;
	actorUserId?: string;
};

/**
 * Normalize a raw entity-type filter value: returns it only when it's one of the
 * constrained AUDIT_ENTITY_TYPES, else `undefined` ("no filter"). Mirrors the
 * transactions list's `parseTypeFilter` — unrecognized junk is ignored, never
 * applied as a (never-matching) literal filter.
 */
export function parseEntityTypeFilter(raw: string | null | undefined): AuditEntityType | undefined {
	return raw != null && (AUDIT_ENTITY_TYPES as readonly string[]).includes(raw)
		? (raw as AuditEntityType)
		: undefined;
}

/**
 * The group activity feed (PLAN §12.1) — access-checked. Reads THIS group's
 * `audit_log` rows newest-first (occurred_at DESC), resolves each actor's display
 * name, applies the optional entity-type / actor filters, and caps at
 * {@link ACTIVITY_LIMIT}. Returns plain serializable rows (occurredAt is an ISO
 * string). NEVER exposes another group's rows.
 *
 * @throws {GroupAccessError} (→404) when the user has no access to the group.
 */
export async function listGroupActivity({
	userId,
	groupId,
	filters = {},
	executor = db
}: {
	userId: string;
	groupId: string;
	filters?: ActivityFilters;
	/** Optional executor (an open tx handle) so this can join a larger transaction. */
	executor?: DbExecutor;
}): Promise<ActivityEntry[]> {
	if (!(await userHasGroupAccess(userId, groupId, executor))) {
		throw new GroupAccessError();
	}

	// Scope to THIS group (never another group's rows), plus the optional filters.
	const conditions = [eq(auditLog.groupId, groupId)];
	if (filters.entityType) conditions.push(eq(auditLog.entityType, filters.entityType));
	if (filters.actorUserId) conditions.push(eq(auditLog.actorUserId, filters.actorUserId));

	const rows = await executor
		.select({
			id: auditLog.id,
			action: auditLog.action,
			entityType: auditLog.entityType,
			entityId: auditLog.entityId,
			summary: auditLog.summary,
			metadata: auditLog.metadata,
			occurredAt: auditLog.occurredAt,
			actorUserId: auditLog.actorUserId,
			// Member name in THIS group (preferred) and the user name (fallback). One of
			// the two resolves the display name below.
			memberName: members.displayName,
			userName: user.name
		})
		.from(auditLog)
		// Prefer the actor's member slot IN THIS GROUP for the display name (§12.1).
		.leftJoin(members, and(eq(members.userId, auditLog.actorUserId), eq(members.groupId, groupId)))
		// Fall back to the better-auth user name when there's no member slot.
		.leftJoin(user, eq(user.id, auditLog.actorUserId))
		.where(and(...conditions))
		// Newest first — matches audit_log_group_id_occurred_at_idx (occurred_at DESC).
		.orderBy(desc(auditLog.occurredAt))
		// Bounded payload (no pagination in v1) — newest ACTIVITY_LIMIT rows.
		.limit(ACTIVITY_LIMIT);

	return rows.map((r) => ({
		id: r.id,
		action: r.action,
		entityType: r.entityType,
		entityId: r.entityId,
		summary: r.summary,
		metadata: r.metadata,
		// Stringify at the service boundary (matches members' deactivatedAt.toISOString()).
		occurredAt: r.occurredAt.toISOString(),
		actorUserId: r.actorUserId,
		// member name → user name → generic label (never crash on a schema-impossible
		// all-null actor).
		actorName: r.memberName ?? r.userName ?? UNKNOWN_ACTOR
	}));
}
