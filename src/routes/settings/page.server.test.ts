import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the auth instance so nothing touches a real DB/network. `listPasskeys`
// and `deletePasskey` are spies we drive per-test. `vi.hoisted` makes them
// available inside the hoisted `vi.mock` factory.
const { listPasskeys, deletePasskey } = vi.hoisted(() => ({
	listPasskeys: vi.fn(),
	deletePasskey: vi.fn()
}));
vi.mock('$lib/server/auth', () => ({
	auth: { api: { listPasskeys, deletePasskey } }
}));

// The API-keys section (PLAN §16.8) is a sibling of the passkeys one. Mock the
// service seam — `api-keys.test.ts` covers the plugin/audit behaviour itself —
// but keep the REAL `ApiKeyNotFoundError`, because the action branches on it.
const { listApiKeysForUser, revokeApiKeyForUser } = vi.hoisted(() => ({
	listApiKeysForUser: vi.fn(),
	revokeApiKeyForUser: vi.fn()
}));
vi.mock('$lib/server/api-keys', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/api-keys')>()),
	listApiKeysForUser,
	revokeApiKeyForUser
}));

import { load, actions } from './+page.server';
import type { PasskeyListItem } from './+page.server';
import { ApiKeyNotFoundError, type ApiKeyListItem } from '$lib/server/api-keys';

/** `load`'s success-branch shape (the redirect branch returns `void`). */
type LoadData = {
	passkeys: PasskeyListItem[];
	apiKeys: ApiKeyListItem[];
	deleteForm: { id: string; data: { id: string } };
	revokeApiKeyForm: { data: { id: string } };
};

type User = { name: string; id?: string };

/** Minimal `load` event with `locals.user` + a real `request` (headers used). */
function makeLoadEvent(user: User | null) {
	return {
		request: new Request('http://localhost/settings'),
		locals: { user, session: user ? {} : null }
	} as unknown as Parameters<typeof load>[0];
}

/** An action event for `?/revokeApiKey` — a form POST plus the session user. */
function makeRevokeEvent(
	fields: Record<string, string>,
	user: User | null = { name: 'A', id: 'u1' }
) {
	const request = new Request('http://localhost/settings', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=abc' },
		body: new URLSearchParams(fields).toString()
	});
	return { request, locals: { user } } as unknown as Parameters<
		(typeof actions)['revokeApiKey']
	>[0];
}

const apiKeyRow: ApiKeyListItem = {
	id: 'key_1',
	name: 'My agent',
	scope: 'read',
	start: 'pwm_test_ab',
	createdAt: '2026-01-02T03:04:05.000Z',
	lastRequest: null,
	expiresAt: null,
	expired: false
};

/** Build a SvelteKit-action `RequestEvent` with a form-encoded POST body. */
function makeActionEvent(fields: Record<string, string>) {
	const body = new URLSearchParams(fields);
	const request = new Request('http://localhost/settings', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return { request } as unknown as Parameters<(typeof actions)['delete']>[0];
}

describe('/settings load', () => {
	beforeEach(() => {
		listPasskeys.mockReset();
		deletePasskey.mockReset();
		listApiKeysForUser.mockReset();
		listApiKeysForUser.mockResolvedValue([]);
		revokeApiKeyForUser.mockReset();
	});

	it('redirects an anonymous user to /login and never lists passkeys', async () => {
		try {
			await load(makeLoadEvent(null));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login');
			}
		}

		expect(listPasskeys).not.toHaveBeenCalled();
		// Nor may an anonymous hit enumerate anyone's API keys.
		expect(listApiKeysForUser).not.toHaveBeenCalled();
	});

	it('returns the mapped passkeys and a valid delete form for an authenticated user', async () => {
		const created = new Date('2026-01-02T03:04:05.000Z');
		listPasskeys.mockResolvedValueOnce([
			{ id: 'pk_1', name: 'My iPhone', aaguid: undefined, createdAt: created },
			{ id: 'pk_2', name: undefined, aaguid: undefined, createdAt: created }
		]);

		const result = (await load(makeLoadEvent({ name: 'Alice' }))) as LoadData;

		expect(listPasskeys).toHaveBeenCalledTimes(1);
		expect(result.passkeys).toEqual([
			{ id: 'pk_1', name: 'My iPhone', deviceHint: null, createdAt: created.toISOString() },
			{ id: 'pk_2', name: null, deviceHint: null, createdAt: created.toISOString() }
		]);
		// A seeded delete form is returned for the per-row forms (its `id` field is
		// filled in per row from the hidden input, so the seed itself is empty).
		expect(result.deleteForm.data).toEqual({ id: '' });
	});

	it('returns an empty list (no 500/redirect) when listPasskeys throws', async () => {
		listPasskeys.mockRejectedValueOnce(new Error('passkey list backend unavailable'));

		const result = (await load(makeLoadEvent({ name: 'Alice' }))) as LoadData;

		expect(result.passkeys).toEqual([]);
		expect(result.deleteForm.data).toEqual({ id: '' });
		expect(listPasskeys).toHaveBeenCalledTimes(1);
	});
});

describe('/settings ?/delete action', () => {
	beforeEach(() => {
		listPasskeys.mockReset();
		deletePasskey.mockReset();
		deletePasskey.mockResolvedValue(undefined);
	});

	it('deletes the passkey by id (forwarding cloned headers) and returns a success message', async () => {
		const result = await actions.delete(makeActionEvent({ id: 'pk_abc' }));

		expect(deletePasskey).toHaveBeenCalledTimes(1);
		const arg = deletePasskey.mock.calls[0][0];
		expect(arg.body).toEqual({ id: 'pk_abc' });
		expect(arg.headers).toBeInstanceOf(Headers);

		const message = (result as { form: { message?: { type: string; text: string } } }).form.message;
		expect(message?.type).toBe('success');
		expect(message?.text).toBe('Passkey removed');
	});

	it('returns a 400 fail and does NOT call deletePasskey on an empty id', async () => {
		const result = (await actions.delete(makeActionEvent({ id: '' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(deletePasskey).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('returns a 400 fail and does NOT call deletePasskey on a missing id', async () => {
		const result = (await actions.delete(makeActionEvent({}))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(deletePasskey).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('returns a generic 500 error (no leak) when deletePasskey throws', async () => {
		deletePasskey.mockRejectedValueOnce(new Error('DB exploded: passkey row pk_secret'));

		const result = (await actions.delete(makeActionEvent({ id: 'pk_abc' }))) as {
			status: number;
			data: { form: { message?: { type: string; text: string } } };
		};

		expect(result.status).toBe(500);
		const message = result.data.form.message;
		expect(message?.type).toBe('error');
		// The raw cause must never reach the user (PLAN §12).
		expect(message?.text).not.toContain('DB exploded');
		expect(message?.text).not.toContain('pk_secret');
	});
});

// ── API keys (PLAN §16.8) ─────────────────────────────────────────────────────

describe('/settings load — API keys section', () => {
	beforeEach(() => {
		listPasskeys.mockReset();
		listPasskeys.mockResolvedValue([]);
		listApiKeysForUser.mockReset();
		revokeApiKeyForUser.mockReset();
	});

	it('returns the caller’s keys and a seeded revoke form', async () => {
		listApiKeysForUser.mockResolvedValueOnce([apiKeyRow]);

		const result = (await load(makeLoadEvent({ name: 'Alice' }))) as LoadData;

		expect(result.apiKeys).toEqual([apiKeyRow]);
		// The per-row revoke forms fill `id` from their hidden input, so the seed is
		// empty — same shape as the passkey delete form.
		expect(result.revokeApiKeyForm.data).toEqual({ id: '' });
	});

	it('renders the empty state (no 500) when the key list fails', async () => {
		listApiKeysForUser.mockRejectedValueOnce(new Error('api-key backend unavailable'));

		const result = (await load(makeLoadEvent({ name: 'Alice' }))) as LoadData;

		expect(result.apiKeys).toEqual([]);
	});
});

describe('/settings ?/revokeApiKey action', () => {
	beforeEach(() => {
		revokeApiKeyForUser.mockReset();
		revokeApiKeyForUser.mockResolvedValue({ id: 'key_1', name: 'My agent' });
	});

	it('revokes the key by id for the session user and reports success', async () => {
		const result = await actions.revokeApiKey(makeRevokeEvent({ id: 'key_1' }));

		expect(revokeApiKeyForUser).toHaveBeenCalledTimes(1);
		const arg = revokeApiKeyForUser.mock.calls[0][0];
		expect(arg.keyId).toBe('key_1');
		expect(arg.userId).toBe('u1');
		// Headers are CLONED before superValidate consumes the body — the plugin's
		// session-scoped delete needs them.
		expect(arg.headers).toBeInstanceOf(Headers);
		expect(arg.headers.get('cookie')).toBe('session=abc');

		const message = (result as { form: { message?: { type: string; text: string } } }).form.message;
		expect(message?.type).toBe('success');
		expect(message?.text).toBe('API key revoked');
	});

	it('returns a 400 fail and revokes nothing on an empty id', async () => {
		const result = (await actions.revokeApiKey(makeRevokeEvent({ id: '' }))) as {
			status: number;
			data: { form: { valid: boolean } };
		};

		expect(revokeApiKeyForUser).not.toHaveBeenCalled();
		expect(result.status).toBe(400);
		expect(result.data.form.valid).toBe(false);
	});

	it('reports a non-committal message for an absent / not-yours key', async () => {
		revokeApiKeyForUser.mockRejectedValueOnce(new ApiKeyNotFoundError());

		const result = (await actions.revokeApiKey(makeRevokeEvent({ id: 'someone-elses' }))) as {
			status: number;
			data: { form: { message?: { type: string; text: string } } };
		};

		expect(result.data.form.message?.type).toBe('error');
		// Says nothing about whether that id exists (no enumeration signal, §16.5).
		expect(result.data.form.message?.text).toBe('That API key no longer exists.');
	});

	it('returns a generic error (no leak) when the revoke blows up', async () => {
		revokeApiKeyForUser.mockRejectedValueOnce(new Error('DB exploded: key row pwm_live_secret'));

		const result = (await actions.revokeApiKey(makeRevokeEvent({ id: 'key_1' }))) as {
			status: number;
			data: { form: { message?: { type: string; text: string } } };
		};

		expect(result.status).toBe(500);
		expect(result.data.form.message?.text).not.toContain('DB exploded');
		expect(result.data.form.message?.text).not.toContain('pwm_live_secret');
	});

	it('redirects an anonymous POST to /login and revokes nothing', async () => {
		try {
			await actions.revokeApiKey(makeRevokeEvent({ id: 'key_1' }, null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('/login');
		}
		expect(revokeApiKeyForUser).not.toHaveBeenCalled();
	});
});
