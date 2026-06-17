import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';
import { groups } from './groups-schema';

// Append-only audit trail (task 4.2 schema; PLAN §9, §12.1).
//
// SCHEMA-ONLY: the table + its two indexes. The audit-WRITE helper (every mutation
// writes one row in the SAME DB transaction) is task 4.6 — not here.
//
// APPEND-ONLY by design: there is NO `updated_at` and NO soft-delete column. Rows
// are written once and never mutated, so the trail is durable evidence (§12.1).
//
// `summary` is DENORMALIZED + durable: a human-readable line captured at write
// time, so entries stay readable even after the referenced entity changes or is
// hard-deleted (§12.1).
//
// `entity_id` is DELIBERATELY NOT a foreign key — it is plain `text`. Per §9 it
// "may dangle after hard-delete": once the underlying entity is gone the id no
// longer resolves, and `summary` (above) carries the durable human label. A real
// FK would either block the delete or cascade the audit row away — both defeat the
// point of an append-only trail.
//
// onDelete: `group_id` → groups.id is `cascade` (audit rows for a hard-deleted
//   group go with it; v1 soft-deletes groups). `actor_user_id` → user.id is NOT
//   NULL + default restrict (durable authorship — who performed it is permanent).
//
// `occurred_at` = server UTC, IMMUTABLE insert time; the DESC sort key in the UI.
//   Same immutable-insert-time meaning as `transactions.occurred_at` (§7.1).
export const auditLog = pgTable(
	'audit_log',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		groupId: text('group_id')
			.notNull()
			.references(() => groups.id, { onDelete: 'cascade' }),
		// Who performed the action → user.id. NOT NULL + default restrict.
		actorUserId: text('actor_user_id')
			.notNull()
			.references(() => user.id),
		// Constrained value set: create | edit | delete | restore | add | deactivate
		// | ... (text; the set is documented, validated at the write layer in 4.6).
		action: text('action').notNull(),
		// Constrained value set: transaction | member | invite | group (text).
		entityType: text('entity_type').notNull(),
		// DELIBERATELY NOT a FK (see header): may dangle after hard-delete.
		entityId: text('entity_id').notNull(),
		// Denormalized, durable human-readable line.
		summary: text('summary').notNull(),
		// JSON metadata: changed fields / before-after snapshot. Nullable (jsonb).
		metadata: jsonb('metadata'),
		// Server UTC insert time; immutable; DESC sort key in the UI.
		occurredAt: timestamp('occurred_at').defaultNow().notNull()
	},
	(table) => [
		// PLAN §9: audit_log(group_id, occurred_at DESC) — the per-group trail, newest
		// first. The DESC matches the UI sort so the index serves the listing order.
		index('audit_log_group_id_occurred_at_idx').on(table.groupId, table.occurredAt.desc()),
		// PLAN §9: audit_log(entity_type, entity_id) — all events for one entity.
		index('audit_log_entity_type_entity_id_idx').on(table.entityType, table.entityId)
	]
);
