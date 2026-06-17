import { describe, it, expect } from 'vitest';
import { getTableName, getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { auditLog } from './audit-schema';
import * as schema from './schema';

// Import-level shape assertions for the append-only `audit_log` table added in
// task 4.2 (PLAN §9, §12.1). No DB connection: we introspect the Drizzle table
// object so the append-only shape, the deliberately-NON-FK `entity_id`, the jsonb
// metadata, and the two §9 indexes (incl. the DESC sort key) are caught at unit
// time. Mirrors `groups-schema.test.ts`.

describe('audit_log drizzle table', () => {
	it('maps to the `audit_log` SQL table', () => {
		expect(getTableName(auditLog)).toBe('audit_log');
	});

	it('exports exactly the expected columns', () => {
		expect(Object.keys(getTableColumns(auditLog)).sort()).toEqual([
			'action',
			'actorUserId',
			'entityId',
			'entityType',
			'groupId',
			'id',
			'metadata',
			'occurredAt',
			'summary'
		]);
	});

	it('is APPEND-ONLY: no updated_at and no soft-delete column', () => {
		const c = getTableColumns(auditLog);
		expect(c).not.toHaveProperty('updatedAt');
		expect(c).not.toHaveProperty('deletedAt');
	});

	it('maps property keys to snake_case columns with the right nullability', () => {
		const c = getTableColumns(auditLog);
		expect(c.id.primary).toBe(true);

		expect(c.groupId.name).toBe('group_id');
		expect(c.groupId.notNull).toBe(true);

		// who performed it → user.id; durable.
		expect(c.actorUserId.name).toBe('actor_user_id');
		expect(c.actorUserId.notNull).toBe(true);

		expect(c.action.name).toBe('action');
		expect(c.action.notNull).toBe(true);

		expect(c.entityType.name).toBe('entity_type');
		expect(c.entityType.notNull).toBe(true);

		// entity_id is plain text (NOT a FK — may dangle after hard-delete).
		expect(c.entityId.name).toBe('entity_id');
		expect(c.entityId.notNull).toBe(true);
		expect(c.entityId.columnType).toBe('PgText');

		// denormalized durable summary.
		expect(c.summary.name).toBe('summary');
		expect(c.summary.notNull).toBe(true);

		// metadata is jsonb, nullable.
		expect(c.metadata.name).toBe('metadata');
		expect(c.metadata.columnType).toBe('PgJsonb');
		expect(c.metadata.notNull).toBe(false);

		// occurred_at = immutable server insert time, defaults to now.
		expect(c.occurredAt.name).toBe('occurred_at');
		expect(c.occurredAt.notNull).toBe(true);
		expect(c.occurredAt.hasDefault).toBe(true);
	});

	it('has exactly two FKs (group_id, actor_user_id) — entity_id is NOT a FK', () => {
		const { foreignKeys } = getTableConfig(auditLog);
		const fkCols = foreignKeys.flatMap((fk) => fk.reference().columns.map((c) => c.name)).sort();
		expect(fkCols).toEqual(['actor_user_id', 'group_id']);
		// entity_id is deliberately absent from the FK set.
		expect(fkCols).not.toContain('entity_id');

		const byCol = (col: string) =>
			foreignKeys.find((fk) => fk.reference().columns.some((c) => c.name === col));
		// group_id cascades; actor durable (default restrict, 'no action').
		expect(byCol('group_id')?.onDelete).toBe('cascade');
		expect(byCol('actor_user_id')?.onDelete).not.toBe('cascade');
	});

	it('declares both PLAN §9 indexes, with (group_id, occurred_at DESC)', () => {
		const { indexes } = getTableConfig(auditLog);
		const names = indexes.map((i) => i.config.name).sort();
		expect(names).toContain('audit_log_group_id_occurred_at_idx');
		expect(names).toContain('audit_log_entity_type_entity_id_idx');

		// The group trail index sorts occurred_at DESC (matches the UI sort). Drizzle
		// records per-column ordering in `indexConfig.order`; assert occurred_at is
		// DESC while group_id stays ASC.
		const groupIdx = indexes.find((i) => i.config.name === 'audit_log_group_id_occurred_at_idx');
		const orders = Object.fromEntries(
			(groupIdx?.config.columns ?? []).map((col) => {
				const c = col as { name?: string; indexConfig?: { order?: string } };
				return [c.name, c.indexConfig?.order];
			})
		);
		expect(orders['occurred_at']).toBe('desc');
		expect(orders['group_id']).toBe('asc');
	});

	it('is re-exported from the schema entry point', () => {
		expect((schema as Record<string, unknown>).auditLog).toBe(auditLog);
	});
});
