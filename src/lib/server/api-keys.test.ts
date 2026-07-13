import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the API-key management service (PLAN §16.8).
//
// STRATEGY (mirrors `invites.test.ts` / the settings route test): no real DB and
// no real better-auth. We mock BOTH seams — the plugin's server API and the `db`
// transaction — so we can assert the guarantees that actually matter:
//   - the ONE-TIME plaintext is passed straight through and never re-derived;
//   - a `read` key is stored with permissions that PHYSICALLY cannot write, using
//     the same encoding the /api/v1 write-guard reads back (§16.2);
//   - "never" really means no `expiresIn` (a non-expiring key), and the presets /
//     custom TTL convert to the right number of seconds;
//   - create and revoke EACH write exactly one `audit_log` row, actor = the user,
//     key id in `metadata`, `groupId: null`, and WITHOUT the "(via API key …)"
//     provenance suffix (that is only for API-driven mutations, §16.2);
//   - revoke conflates "absent" and "not yours" into one not-found error.

const { createApiKey, deleteApiKey, getApiKey, listApiKeys, auditRows, transaction } = vi.hoisted(
	() => {
		const auditRows: unknown[] = [];
		// A `db.transaction(cb)` stub handing the callback a `tx` whose only
		// capability is `insert(...).values(...)` — exactly what `writeAuditLog`
		// needs, and nothing more (it must never open its own transaction).
		const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
			cb({
				insert: () => ({
					values: async (values: unknown) => {
						auditRows.push(values);
					}
				})
			})
		);
		return {
			createApiKey: vi.fn(),
			deleteApiKey: vi.fn(),
			getApiKey: vi.fn(),
			listApiKeys: vi.fn(),
			auditRows,
			transaction
		};
	}
);

vi.mock('$lib/server/auth', () => ({
	auth: { api: { createApiKey, deleteApiKey, getApiKey, listApiKeys } }
}));
vi.mock('$lib/server/db', () => ({ db: { transaction } }));

import {
	ApiKeyNotFoundError,
	createApiKeyForUser,
	expiresInSeconds,
	listApiKeysForUser,
	maskApiKeySecret,
	revokeApiKeyForUser,
	toApiKeyListItem
} from './api-keys';
import type { CreateApiKeyInput } from '$lib/schemas/api-key';

const SECONDS_PER_DAY = 86_400;
const USER_ID = 'user_1';

function makeInput(overrides: Partial<CreateApiKeyInput> = {}): CreateApiKeyInput {
	return { name: 'My agent', scope: 'read', expiry: 'never', ...overrides };
}

/** The single audit row written by the call under test. */
function onlyAuditRow(): Record<string, unknown> {
	expect(auditRows).toHaveLength(1);
	return auditRows[0] as Record<string, unknown>;
}

beforeEach(() => {
	createApiKey.mockReset();
	deleteApiKey.mockReset();
	getApiKey.mockReset();
	listApiKeys.mockReset();
	transaction.mockClear();
	auditRows.length = 0;
});

describe('expiresInSeconds (PLAN §16.8 expiry presets)', () => {
	it('returns undefined for "never" — the key must NOT get an expiresAt', () => {
		// The plugin only stamps `expiresAt` when `expiresIn` is truthy, so
		// `undefined` is exactly what makes a key non-expiring (§16.2 default).
		expect(expiresInSeconds({ expiry: 'never' })).toBeUndefined();
	});

	it('converts each preset to seconds', () => {
		expect(expiresInSeconds({ expiry: '30' })).toBe(30 * SECONDS_PER_DAY);
		expect(expiresInSeconds({ expiry: '90' })).toBe(90 * SECONDS_PER_DAY);
		expect(expiresInSeconds({ expiry: '365' })).toBe(365 * SECONDS_PER_DAY);
	});

	it('converts a custom day count to seconds', () => {
		expect(expiresInSeconds({ expiry: 'custom', customDays: 14 })).toBe(14 * SECONDS_PER_DAY);
	});

	it('ignores customDays unless the choice IS "custom"', () => {
		// The custom input is always rendered (no-JS), so a stale value can ride
		// along with any choice. It must never shorten a "never" key's life.
		expect(expiresInSeconds({ expiry: 'never', customDays: 30 })).toBeUndefined();
		expect(expiresInSeconds({ expiry: '90', customDays: 1 })).toBe(90 * SECONDS_PER_DAY);
	});
});

describe('maskApiKeySecret', () => {
	it('keeps the recognizable head and hides the rest', () => {
		const masked = maskApiKeySecret('pwm_test_abcdefghijklmnop');
		expect(masked.startsWith('pwm_test_abc')).toBe(true);
		// The tail must not survive anywhere in the masked string.
		expect(masked).not.toContain('mnop');
	});

	it('never lengthens or mangles a short value', () => {
		expect(maskApiKeySecret('short')).toBe('short');
	});
});

describe('toApiKeyListItem', () => {
	const now = new Date('2026-07-13T00:00:00.000Z');

	it('decodes the scope from the plugin permissions the write-guard reads (§16.2)', () => {
		expect(
			toApiKeyListItem({ id: 'k', createdAt: now, permissions: { api: ['read'] } }, now).scope
		).toBe('read');
		expect(
			toApiKeyListItem({ id: 'k', createdAt: now, permissions: { api: ['read', 'write'] } }, now)
				.scope
		).toBe('write');
	});

	it('treats missing/empty permissions as READ — least privilege', () => {
		expect(toApiKeyListItem({ id: 'k', createdAt: now, permissions: null }, now).scope).toBe(
			'read'
		);
		expect(toApiKeyListItem({ id: 'k', createdAt: now }, now).scope).toBe('read');
	});

	it('flags an expired key and leaves a never-expiring one unflagged', () => {
		const past = new Date(now.getTime() - 1000);
		const future = new Date(now.getTime() + 1000);
		expect(toApiKeyListItem({ id: 'k', createdAt: now, expiresAt: past }, now).expired).toBe(true);
		expect(toApiKeyListItem({ id: 'k', createdAt: now, expiresAt: future }, now).expired).toBe(
			false
		);
		const never = toApiKeyListItem({ id: 'k', createdAt: now, expiresAt: null }, now);
		expect(never.expired).toBe(false);
		expect(never.expiresAt).toBeNull();
	});

	it('exposes the safe `start` prefix and "never used" as a null lastRequest', () => {
		const item = toApiKeyListItem(
			{ id: 'k', createdAt: now, start: 'pwm_test_ab', lastRequest: null },
			now
		);
		expect(item.start).toBe('pwm_test_ab');
		expect(item.lastRequest).toBeNull();
	});
});

describe('listApiKeysForUser', () => {
	it('maps the plugin rows and sorts newest-first', async () => {
		listApiKeys.mockResolvedValue({
			apiKeys: [
				{ id: 'old', createdAt: new Date('2026-01-01T00:00:00Z'), permissions: { api: ['read'] } },
				{
					id: 'new',
					createdAt: new Date('2026-06-01T00:00:00Z'),
					permissions: { api: ['read', 'write'] }
				}
			],
			total: 2
		});

		const keys = await listApiKeysForUser({ headers: new Headers() });
		expect(keys.map((k) => k.id)).toEqual(['new', 'old']);
		expect(keys[0].scope).toBe('write');
	});

	it('passes the caller’s session headers through (the plugin scopes to the owner)', async () => {
		listApiKeys.mockResolvedValue({ apiKeys: [], total: 0 });
		const headers = new Headers({ cookie: 'session=abc' });
		await listApiKeysForUser({ headers });
		expect(listApiKeys).toHaveBeenCalledWith(expect.objectContaining({ headers }));
	});
});

describe('createApiKeyForUser (PLAN §16.8)', () => {
	function mockCreated(overrides: Record<string, unknown> = {}) {
		createApiKey.mockResolvedValue({
			id: 'key_1',
			name: 'My agent',
			start: 'pwm_test_ab',
			expiresAt: null,
			key: 'pwm_test_secret-plaintext',
			...overrides
		});
	}

	it('returns the ONE-TIME plaintext exactly as the plugin minted it', async () => {
		mockCreated();
		const created = await createApiKeyForUser({ userId: USER_ID, input: makeInput() });
		// This is the only moment the secret exists in the clear (§16.1) — the
		// reveal screen depends on it arriving untouched.
		expect(created.key).toBe('pwm_test_secret-plaintext');
		expect(created.id).toBe('key_1');
		expect(created.start).toBe('pwm_test_ab');
	});

	it('stores a READ key with permissions that cannot write (§16.2 money safety)', async () => {
		mockCreated();
		await createApiKeyForUser({ userId: USER_ID, input: makeInput({ scope: 'read' }) });

		const body = createApiKey.mock.calls[0][0].body;
		expect(body.permissions).toEqual({ api: ['read'] });
		expect(body.userId).toBe(USER_ID);
	});

	it('stores a WRITE key with BOTH actions (write ⊇ read)', async () => {
		mockCreated();
		await createApiKeyForUser({ userId: USER_ID, input: makeInput({ scope: 'write' }) });
		expect(createApiKey.mock.calls[0][0].body.permissions).toEqual({ api: ['read', 'write'] });
	});

	it('calls the SERVER-side path (no headers) — the plugin rejects `permissions` otherwise', async () => {
		mockCreated();
		await createApiKeyForUser({ userId: USER_ID, input: makeInput() });
		// A request carrying headers is treated as a "client request" by the plugin,
		// which then 400s on the server-only `permissions` property. Passing the
		// resolved `userId` in the body instead is what keeps scopes possible.
		expect(createApiKey.mock.calls[0][0]).not.toHaveProperty('headers');
	});

	it('omits expiresIn for a never-expiring key, and sets it for presets/custom', async () => {
		mockCreated();
		await createApiKeyForUser({ userId: USER_ID, input: makeInput({ expiry: 'never' }) });
		expect(createApiKey.mock.calls[0][0].body.expiresIn).toBeUndefined();

		createApiKey.mockClear();
		auditRows.length = 0;
		mockCreated();
		await createApiKeyForUser({ userId: USER_ID, input: makeInput({ expiry: '90' }) });
		expect(createApiKey.mock.calls[0][0].body.expiresIn).toBe(90 * SECONDS_PER_DAY);

		createApiKey.mockClear();
		auditRows.length = 0;
		mockCreated();
		await createApiKeyForUser({
			userId: USER_ID,
			input: makeInput({ expiry: 'custom', customDays: 7 })
		});
		expect(createApiKey.mock.calls[0][0].body.expiresIn).toBe(7 * SECONDS_PER_DAY);
	});

	it('writes exactly ONE audit row: actor = user, key id in metadata, no group', async () => {
		mockCreated();
		await createApiKeyForUser({ userId: USER_ID, input: makeInput({ scope: 'write' }) });

		const row = onlyAuditRow();
		expect(row.actorUserId).toBe(USER_ID);
		expect(row.action).toBe('create');
		expect(row.entityType).toBe('api_key');
		expect(row.entityId).toBe('key_1');
		// Account-level: an API key belongs to a user, not a group.
		expect(row.groupId).toBeNull();
		expect(row.metadata).toMatchObject({ keyId: 'key_1', keyName: 'My agent', scope: 'write' });
		// Durable, human-readable line — and NO "(via API key …)" suffix: this
		// create came from the WEB SESSION, not from an API key (§16.2).
		expect(row.summary).toBe("Created API key 'My agent' (write access)");
		expect(row.summary).not.toContain('via API key');
		// The secret must never reach the audit trail.
		expect(JSON.stringify(row)).not.toContain('secret-plaintext');
	});

	it('writes the audit row through a real db transaction (never a bare insert)', async () => {
		mockCreated();
		await createApiKeyForUser({ userId: USER_ID, input: makeInput() });
		expect(transaction).toHaveBeenCalledTimes(1);
	});

	it('propagates a mint failure and audits nothing', async () => {
		createApiKey.mockRejectedValue(new Error('plugin exploded'));
		await expect(createApiKeyForUser({ userId: USER_ID, input: makeInput() })).rejects.toThrow();
		expect(auditRows).toHaveLength(0);
	});
});

describe('revokeApiKeyForUser (PLAN §16.8, §16.2)', () => {
	it('deletes the key and writes exactly ONE audit row', async () => {
		getApiKey.mockResolvedValue({ id: 'key_1', name: 'My agent' });
		deleteApiKey.mockResolvedValue({ success: true });

		const result = await revokeApiKeyForUser({
			userId: USER_ID,
			keyId: 'key_1',
			headers: new Headers()
		});

		expect(deleteApiKey).toHaveBeenCalledWith(
			expect.objectContaining({ body: { keyId: 'key_1' } })
		);
		expect(result).toEqual({ id: 'key_1', name: 'My agent' });

		const row = onlyAuditRow();
		expect(row.actorUserId).toBe(USER_ID);
		expect(row.action).toBe('revoke');
		expect(row.entityType).toBe('api_key');
		expect(row.entityId).toBe('key_1');
		expect(row.groupId).toBeNull();
		expect(row.metadata).toMatchObject({ keyId: 'key_1', keyName: 'My agent' });
		// The name is captured BEFORE the delete — after it, the row is gone for
		// good, so this summary is the only durable record of which key it was.
		expect(row.summary).toBe("Revoked API key 'My agent'");
		expect(row.summary).not.toContain('via API key');
	});

	it('passes session headers to BOTH plugin calls (ownership is enforced there)', async () => {
		getApiKey.mockResolvedValue({ id: 'key_1', name: null });
		deleteApiKey.mockResolvedValue({ success: true });
		const headers = new Headers({ cookie: 'session=abc' });

		await revokeApiKeyForUser({ userId: USER_ID, keyId: 'key_1', headers });

		expect(getApiKey).toHaveBeenCalledWith(expect.objectContaining({ headers }));
		expect(deleteApiKey).toHaveBeenCalledWith(expect.objectContaining({ headers }));
	});

	it('conflates "absent" and "someone else’s key" into ApiKeyNotFoundError, deleting nothing', async () => {
		// The plugin 404s when the key’s referenceId isn’t the session user — we
		// must not distinguish that from a non-existent id (no enumeration signal).
		getApiKey.mockRejectedValue(new Error('NOT_FOUND'));

		await expect(
			revokeApiKeyForUser({ userId: USER_ID, keyId: 'someone-elses', headers: new Headers() })
		).rejects.toBeInstanceOf(ApiKeyNotFoundError);

		expect(deleteApiKey).not.toHaveBeenCalled();
		expect(auditRows).toHaveLength(0);
	});

	it('audits nothing when the delete itself fails', async () => {
		getApiKey.mockResolvedValue({ id: 'key_1', name: 'My agent' });
		deleteApiKey.mockRejectedValue(new Error('boom'));

		await expect(
			revokeApiKeyForUser({ userId: USER_ID, keyId: 'key_1', headers: new Headers() })
		).rejects.toBeInstanceOf(ApiKeyNotFoundError);
		// An audit row for a revoke that did not happen would be a lie.
		expect(auditRows).toHaveLength(0);
	});

	it('falls back to a readable label for an unnamed key', async () => {
		getApiKey.mockResolvedValue({ id: 'key_1', name: null });
		deleteApiKey.mockResolvedValue({ success: true });

		await revokeApiKeyForUser({ userId: USER_ID, keyId: 'key_1', headers: new Headers() });

		const row = onlyAuditRow();
		expect(row.summary).toBe("Revoked API key 'unnamed'");
		// `metadata` still records the truthful null.
		expect(row.metadata).toMatchObject({ keyName: null });
	});
});
