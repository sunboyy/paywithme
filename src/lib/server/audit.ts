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
 */
export const AUDIT_ENTITY_TYPES = ['transaction', 'member', 'invite', 'group'] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * One immutable, append-only audit entry (PLAN §12.1). All fields are
 * SERVER-DERIVED by the caller — never client-supplied. `occurredAt`/`id` are
 * intentionally absent: the DB defaults stamp them (`audit-schema.ts`).
 */
export interface AuditEntry {
	/** The group this action happened in. */
	groupId: string;
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
 */
export async function writeAuditLog(tx: AuditExecutor, entry: AuditEntry): Promise<void> {
	await tx.insert(auditLog).values({
		groupId: entry.groupId,
		actorUserId: entry.actorUserId,
		action: entry.action,
		entityType: entry.entityType,
		entityId: entry.entityId,
		summary: entry.summary,
		// Normalize "absent" to an explicit null jsonb (vs leaving the key off) so
		// the stored row is unambiguous.
		metadata: entry.metadata ?? null
	});
}
