import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the audit-log write helper (task 4.6; PLAN §12.1).
//
// STRATEGY (mirrors `groups.test.ts`/`members.test.ts`): NO real DB. We mock
// `$lib/server/db` with the same fluent stub so we can prove the helper NEVER
// uses the global `db` (the same-transaction guarantee is structural — a caller
// must hand over their own `tx`). We then drive the helper with a separate mock
// `tx` and assert the MEANINGFUL guarantees:
//   - it inserts into `auditLog` with EXACTLY the provided fields → columns;
//   - it inserts THROUGH the passed executor, exactly once, and NEVER opens its
//     own transaction nor touches the global `db`;
//   - it does NOT supply `occurredAt`/`id` (left to DB defaults → server time);
//   - `metadata` omitted → `null`; provided → passed through;
//   - type-level: unknown actions/entity-types are rejected (@ts-expect-error).

// --- Global `db` mock — present ONLY to prove it is NEVER used --------------
// Every method is a spy that throws if called: if the helper ever reached for
// the global `db` (its own transaction / a fallback executor), a test would blow
// up loudly instead of silently breaking atomicity.
const { dbTransactionSpy, dbInsertSpy } = vi.hoisted(() => {
	const dbTransactionSpy = vi.fn(() => {
		throw new Error('helper must NOT open its own db.transaction(...)');
	});
	const dbInsertSpy = vi.fn(() => {
		throw new Error('helper must NOT use the global db (breaks same-transaction)');
	});
	return { dbTransactionSpy, dbInsertSpy };
});

vi.mock('$lib/server/db', () => ({
	db: {
		transaction: dbTransactionSpy,
		insert: dbInsertSpy,
		select: dbInsertSpy,
		update: dbInsertSpy,
		delete: dbInsertSpy
	}
}));

import { writeAuditLog, AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from './audit';
import { auditLog } from './db/audit-schema';

// --- Mock transaction handle (`tx`) ----------------------------------------
// Records every `insert(table).values(v)` so a test can assert the table and the
// exact values object. `values` resolves (thenable-style) like the real builder.
function makeTx() {
	const insertCalls: { table: unknown; values: Record<string, unknown> }[] = [];
	const tx = {
		insert: vi.fn((table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				insertCalls.push({ table, values });
				return Promise.resolve(undefined);
			}
		}))
	};
	return { tx, insertCalls };
}

const baseEntry = {
	groupId: 'group-1',
	actorUserId: 'user-42',
	action: 'edit' as const,
	entityType: 'transaction' as const,
	entityId: 'txn-9',
	summary: "Edited 'Dinner' — amount ฿800 → ฿950"
};

beforeEach(() => {
	dbTransactionSpy.mockClear();
	dbInsertSpy.mockClear();
});

describe('writeAuditLog (PLAN §12.1 — append-only, same-transaction)', () => {
	it('inserts into the auditLog table with exactly the provided fields → columns', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, { ...baseEntry, metadata: { amount: [800, 950] } });

		expect(insertCalls).toHaveLength(1);
		expect(insertCalls[0].table).toBe(auditLog);
		expect(insertCalls[0].values).toEqual({
			groupId: 'group-1',
			actorUserId: 'user-42',
			action: 'edit',
			entityType: 'transaction',
			entityId: 'txn-9',
			summary: "Edited 'Dinner' — amount ฿800 → ฿950",
			metadata: { amount: [800, 950] }
		});
	});

	it('inserts THROUGH the passed executor exactly once', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, baseEntry);

		expect(tx.insert).toHaveBeenCalledTimes(1);
		expect(tx.insert).toHaveBeenCalledWith(auditLog);
		expect(insertCalls).toHaveLength(1);
	});

	it('NEVER opens its own transaction and NEVER touches the global db', async () => {
		const { tx } = makeTx();

		await writeAuditLog(tx, baseEntry);

		// The whole point of §12.1: the row joins the caller's transaction, so the
		// helper must not reach for the global db in any way.
		expect(dbTransactionSpy).not.toHaveBeenCalled();
		expect(dbInsertSpy).not.toHaveBeenCalled();
	});

	it('does NOT supply occurredAt or id (left to the DB default → server time)', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, baseEntry);

		const values = insertCalls[0].values;
		// The server clock — not the caller — stamps the immutable insert/sort time.
		expect(values).not.toHaveProperty('occurredAt');
		expect(values).not.toHaveProperty('id');
	});

	it('stores metadata as null when omitted', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, baseEntry); // no `metadata` key

		expect(insertCalls[0].values.metadata).toBeNull();
	});

	it('stores metadata as null when explicitly undefined', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, { ...baseEntry, metadata: undefined });

		expect(insertCalls[0].values.metadata).toBeNull();
	});

	it('passes metadata through when provided', async () => {
		const { tx, insertCalls } = makeTx();
		const snapshot = { before: { amount: 800 }, after: { amount: 950 } };

		await writeAuditLog(tx, { ...baseEntry, metadata: snapshot });

		expect(insertCalls[0].values.metadata).toEqual(snapshot);
	});
});

describe('constrained value sets (PLAN §12.1)', () => {
	it('exposes the documented action set', () => {
		expect(AUDIT_ACTIONS).toEqual([
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
		]);
	});

	it('exposes the documented entity-type set', () => {
		expect(AUDIT_ENTITY_TYPES).toEqual(['transaction', 'member', 'invite', 'group']);
	});

	it('type-rejects unknown action / entityType (compile-time guard)', async () => {
		const { tx } = makeTx();

		// @ts-expect-error — 'frobnicate' is not an AuditAction.
		await writeAuditLog(tx, { ...baseEntry, action: 'frobnicate' });
		// @ts-expect-error — 'spaceship' is not an AuditEntityType.
		await writeAuditLog(tx, { ...baseEntry, entityType: 'spaceship' });

		// (These run fine at runtime — the assertion is the compile-time error the
		// `@ts-expect-error` directives require; `pnpm check` fails if either line
		// stops being a type error.)
		expect(true).toBe(true);
	});
});
