// Audit-log write helper (task 4.6; PLAN §12.1). CLAUDE.md: "Every mutation
// writes an append-only audit_log row in the same DB transaction" — this module
// is that single mechanism, and the only place an `audit_log` row is ever
// written.
//
// THE SAME-TRANSACTION CONTRACT (the crux, PLAN §12.1). The audit row must
// commit or roll back ATOMICALLY with the mutation it records, so the trail can
// never drift from what actually happened. This helper enforces that structurally:
//   - It takes the caller's OPEN TRANSACTION HANDLE (`tx`) as a parameter and
//     inserts THROUGH it. The insert therefore joins the caller's transaction.
//   - It NEVER opens its own `db.transaction(...)` — that would be a separate,
//     independently-committing unit of work (broken atomicity).
//   - It NEVER imports or falls back to the global `db` proxy — there is no
//     default executor, so a caller physically cannot write an audit row outside
//     a transaction. (`AuditExecutor` requires only `insert`, the single
//     capability this helper needs; mirrors the `DbExecutor` idea in
//     `groups.ts`/`members.ts` but pared to what's used here.)
//
// SERVER-DERIVED ONLY (PLAN §12.1): no client-supplied data drives the row. The
// caller passes server-derived values (the authenticated actor, the action it
// just performed, a summary it composed). `occurredAt` and `id` are DB defaults
// (see `audit-schema.ts`) — deliberately NOT accepted here so the server clock,
// not the caller, stamps the immutable insert time / sort key.

import { auditLog } from './db/audit-schema';

/**
 * The minimal executor this helper needs: an OPEN transaction handle (or any
 * runner) that can `insert`. Typed as the `insert` capability of an `auditLog`
 * insert so callers must hand over their transaction `tx` — there is
 * intentionally no `db` default, which makes writing outside a transaction
 * impossible (PLAN §12.1 same-transaction guarantee). Shaped like the
 * `Pick<typeof db, 'insert' | …>` executor types in `groups.ts`/`members.ts`.
 */
export type AuditExecutor = {
	insert: (table: typeof auditLog) => {
		values: (values: typeof auditLog.$inferInsert) => Promise<unknown> | { then?: unknown };
	};
};

/**
 * Mutating actions recorded in the audit trail (PLAN §12.1). The `audit_log`
 * table stores `action` as `text`; this is the constrained value set the write
 * layer validates (per the schema comment in `audit-schema.ts`).
 *
 * Priority per §12.1: transactions' create/edit/delete/restore, plus member
 * add/deactivate/reactivate, invite create/revoke, and group rename/currency_set/
 * delete. Extensible — add new verbs here as later tasks introduce mutations.
 */
export const AUDIT_ACTIONS = [
	'create',
	'edit',
	'delete',
	'restore',
	'add',
	'deactivate',
	'reactivate',
	'revoke',
	'rename',
	'currency_set'
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The entity kinds an audit entry can be attached to (PLAN §12.1). Stored as
 * `text` in `audit_log.entity_type`; validated here at the write layer.
 *
 * `api_key` (PLAN §16.8) is the one ACCOUNT-LEVEL kind: an API key belongs to a
 * user, not to a group, so those rows carry `groupId: null` (see `AuditEntry.
 * groupId`). Every other kind is group-scoped.
 */
export const AUDIT_ENTITY_TYPES = ['transaction', 'member', 'invite', 'group', 'api_key'] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * The GROUP-SCOPED entity kinds — i.e. every kind except the account-level
 * `api_key`. This is the set the group activity feed's entity filter offers
 * (§12.1 "optional filters by entity type"): an `api_key` row always carries
 * `groupId: null`, so it can never appear in ANY group's feed, and offering it as
 * a filter option would be a menu entry that is guaranteed to return nothing.
 */
export const GROUP_AUDIT_ENTITY_TYPES = AUDIT_ENTITY_TYPES.filter(
	(type) => type !== 'api_key'
) as readonly Exclude<AuditEntityType, 'api_key'>[];

/** An entity kind that lives inside a group (everything but `api_key`). */
export type GroupAuditEntityType = (typeof GROUP_AUDIT_ENTITY_TYPES)[number];

/**
 * PROVENANCE for an API-key-driven mutation (PLAN §16.2, "Audit actor — zero
 * schema change").
 *
 * A key carries NO independent authority: it acts *as* its creating user, so
 * `actorUserId` stays the USER id. "Which key" is provenance only, and it is
 * recorded WITHOUT a schema change — no `actor_key_id` column (explicitly
 * rejected): the key id + label go into the existing nullable `metadata` jsonb as
 * `{ viaKey, keyName }`, and the durable `summary` gets a
 * "(via API key '<name>')" suffix so an old entry still reads correctly even if
 * the key is later revoked and hard-deleted. (A Postgres expression index on
 * `(metadata->>'viaKey')` can serve per-key lookups later without touching the
 * append-only table.)
 *
 * Absent (`undefined`) for a WEB-SESSION mutation — those rows get no suffix and
 * no `viaKey`/`keyName` metadata, which is exactly how the two origins are told
 * apart.
 */
export interface AuditVia {
	/** The API key's own id → `metadata.viaKey`. */
	keyId: string;
	/** The key's human label → `metadata.keyName` + the summary suffix. */
	keyName: string | null;
}

/**
 * The label used in the summary suffix when a key carries no name (the plugin's
 * `name` is nullable). `metadata.keyName` still stores the truthful `null` — this
 * fallback only keeps the human-readable line well-formed.
 */
export const UNNAMED_API_KEY_LABEL = 'unnamed';

/**
 * The durable "(via API key '<name>')" suffix (PLAN §16.2). Exported so tests and
 * any future audit writer compose the SAME string — the format lives in exactly
 * one place.
 */
export function viaKeySummarySuffix(via: AuditVia): string {
	return ` (via API key '${via.keyName ?? UNNAMED_API_KEY_LABEL}')`;
}

/**
 * Merge `{ viaKey, keyName }` into an entry's existing `metadata` jsonb. A plain
 * object is SPREAD (the service's changed-fields snapshot is preserved); anything
 * else (absent/null, or a non-object metadata value) is kept intact under
 * `details` so no information is lost and the provenance keys still sit at the top
 * level where an expression index on `metadata->>'viaKey'` can find them.
 */
function withViaMetadata(metadata: unknown, via: AuditVia): Record<string, unknown> {
	const provenance = { viaKey: via.keyId, keyName: via.keyName };
	if (metadata === undefined || metadata === null) return provenance;
	if (typeof metadata === 'object' && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>), ...provenance };
	}
	return { details: metadata, ...provenance };
}

/**
 * One immutable, append-only audit entry (PLAN §12.1). All fields are
 * SERVER-DERIVED by the caller — never client-supplied. `occurredAt`/`id` are
 * intentionally absent: the DB defaults stamp them (`audit-schema.ts`).
 */
export interface AuditEntry {
	/**
	 * The group this action happened in — or `null` for an ACCOUNT-LEVEL action
	 * that belongs to no group (PLAN §16.8: API-key create/revoke). A null-group
	 * row never surfaces in a group activity feed (`activity.ts` always filters on
	 * a concrete `group_id`), which is the intended visibility.
	 */
	groupId: string | null;
	/** The authenticated user who performed it — durable authorship key (§12.1). */
	actorUserId: string;
	/** What was done (constrained set). */
	action: AuditAction;
	/** What kind of entity it was done to (constrained set). */
	entityType: AuditEntityType;
	/**
	 * The affected entity's id. DELIBERATELY plain text, may dangle after
	 * hard-delete (see `audit-schema.ts`); `summary` carries the durable label.
	 */
	entityId: string;
	/**
	 * Short human-readable line composed server-side, e.g.
	 * "Edited 'Dinner' — amount ฿800 → ฿950". Required and durable (§12.1).
	 */
	summary: string;
	/**
	 * Optional changed-fields / before-after snapshot, serialized to jsonb. Omit
	 * (or pass `undefined`) when there's nothing to record → stored as `null`.
	 */
	metadata?: unknown;
	/**
	 * API-key provenance (PLAN §16.2) — set ONLY when the mutation came through
	 * `/api/v1` with a key. {@link writeAuditLog} then appends the
	 * "(via API key '<name>')" summary suffix and merges `{ viaKey, keyName }` into
	 * `metadata`. `actorUserId` is UNCHANGED (still the user). Omitted for a
	 * web-session mutation → that row carries no suffix and no provenance keys.
	 */
	via?: AuditVia;
}

/**
 * Append exactly ONE immutable `audit_log` row, IN THE CALLER'S TRANSACTION.
 *
 * Pass the open transaction handle (`tx`) from the mutation's
 * `db.transaction(async (tx) => …)` so the audit row commits/rolls back with the
 * mutation (PLAN §12.1). The helper inserts through `tx` only — it never opens
 * its own transaction and never touches the global `db`.
 *
 * `id` and `occurredAt` are left to the schema defaults so the SERVER stamps the
 * immutable insert time; the caller cannot supply them.
 *
 * When `entry.via` is present (an API-key-driven mutation, PLAN §16.2) the row is
 * decorated with provenance HERE — the one place the format is defined: the
 * summary gets the "(via API key '<name>')" suffix and `metadata` gains
 * `{ viaKey, keyName }`. `actorUserId` is never rewritten (the key acts AS the
 * user), and NO schema change is involved.
 */
export async function writeAuditLog(tx: AuditExecutor, entry: AuditEntry): Promise<void> {
	await tx.insert(auditLog).values({
		groupId: entry.groupId,
		actorUserId: entry.actorUserId,
		action: entry.action,
		entityType: entry.entityType,
		entityId: entry.entityId,
		summary: entry.via ? `${entry.summary}${viaKeySummarySuffix(entry.via)}` : entry.summary,
		// Normalize "absent" to an explicit null jsonb (vs leaving the key off) so
		// the stored row is unambiguous. With `via`, provenance is merged in (and an
		// otherwise-absent metadata becomes the provenance object itself).
		metadata: entry.via ? withViaMetadata(entry.metadata, entry.via) : (entry.metadata ?? null)
	});
}
