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

import {
	writeAuditLog,
	viaKeySummarySuffix,
	AUDIT_ACTIONS,
	AUDIT_ENTITY_TYPES,
	GROUP_AUDIT_ENTITY_TYPES
} from './audit';
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
		// `api_key` (PLAN §16.8) is the one ACCOUNT-LEVEL kind — it is the reason
		// `groupId` is nullable on an entry.
		expect(AUDIT_ENTITY_TYPES).toEqual(['transaction', 'member', 'invite', 'group', 'api_key']);
	});

	it('exposes the GROUP-scoped subset separately (no api_key)', () => {
		// The group activity feed's entity filter offers only these: an `api_key` row
		// carries `groupId: null`, so filtering a group feed by it could only ever
		// return an empty list.
		expect(GROUP_AUDIT_ENTITY_TYPES).toEqual(['transaction', 'member', 'invite', 'group']);
	});

	it('accepts an account-level entry with a null group (PLAN §16.8)', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, {
			...baseEntry,
			groupId: null,
			action: 'create',
			entityType: 'api_key',
			entityId: 'key_1',
			summary: "Created API key 'My agent' (read access)",
			metadata: { keyId: 'key_1' }
		});

		expect(insertCalls).toHaveLength(1);
		expect(insertCalls[0].values).toMatchObject({
			groupId: null,
			entityType: 'api_key',
			entityId: 'key_1'
		});
		// No `via` ⇒ no "(via API key …)" suffix: this is a web-session action, not a
		// mutation DRIVEN BY a key (§16.2).
		expect(insertCalls[0].values.summary).not.toContain('via API key');
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

// --- API-key provenance (PLAN §16.2, task #22) ------------------------------
// The writer is the ONE place the provenance format lives: `via` → a
// "(via API key '<name>')" summary suffix + `{viaKey,keyName}` merged into the
// EXISTING nullable `metadata` jsonb. Zero schema change; the actor is untouched.
describe('writeAuditLog — API-key provenance (PLAN §16.2)', () => {
	const via = { keyId: 'key_abc', keyName: 'agent key' };

	it('merges {viaKey,keyName} into metadata and suffixes the summary — actor UNCHANGED', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, { ...baseEntry, metadata: { amount: [800, 950] }, via });

		const values = insertCalls[0].values;
		// The key carries no authority: the durable actor is still the USER (§16.2).
		expect(values.actorUserId).toBe('user-42');
		expect(values.metadata).toEqual({
			amount: [800, 950],
			viaKey: 'key_abc',
			keyName: 'agent key'
		});
		expect(values.summary).toBe("Edited 'Dinner' — amount ฿800 → ฿950 (via API key 'agent key')");
		// No `actor_key_id` (or any other new column) is ever written — the row keeps the
		// existing shape (PLAN §16.2 explicitly rejects that column).
		expect(Object.keys(values).sort()).toEqual([
			'action',
			'actorUserId',
			'entityId',
			'entityType',
			'groupId',
			'metadata',
			'summary'
		]);
	});

	it('with NO metadata, the provenance object becomes the metadata (not null)', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, { ...baseEntry, via });

		expect(insertCalls[0].values.metadata).toEqual({ viaKey: 'key_abc', keyName: 'agent key' });
	});

	it('a non-object metadata is preserved under `details`, provenance stays top-level', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, { ...baseEntry, metadata: 'legacy note', via });

		expect(insertCalls[0].values.metadata).toEqual({
			details: 'legacy note',
			viaKey: 'key_abc',
			keyName: 'agent key'
		});
	});

	it('an unnamed key falls back to a well-formed label; metadata keeps the null', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, { ...baseEntry, via: { keyId: 'key_x', keyName: null } });

		expect(insertCalls[0].values.summary).toContain("(via API key 'unnamed')");
		expect(insertCalls[0].values.metadata).toEqual({ viaKey: 'key_x', keyName: null });
		expect(viaKeySummarySuffix({ keyId: 'key_x', keyName: null })).toBe(" (via API key 'unnamed')");
	});

	it('WITHOUT `via` (a web-session mutation) the row is untouched — no suffix, no keys', async () => {
		const { tx, insertCalls } = makeTx();

		await writeAuditLog(tx, { ...baseEntry, metadata: { amount: [800, 950] } });

		expect(insertCalls[0].values.summary).toBe("Edited 'Dinner' — amount ฿800 → ฿950");
		expect(insertCalls[0].values.metadata).toEqual({ amount: [800, 950] });
	});
});
