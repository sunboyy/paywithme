import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Mock the service seam — `api-keys.test.ts` covers the plugin/audit behaviour
// itself — but keep the REAL `ApiKeyNotFoundError`, because the action branches
// on it.
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
import { ApiKeyNotFoundError, type ApiKeyListItem } from '$lib/server/api-keys';

/** `load`'s success-branch shape (the redirect branch returns `void`). */
type LoadData = {
	apiKeys: ApiKeyListItem[];
	revokeApiKeyForm: { data: { id: string } };
};

type User = { name: string; id?: string };

/** Minimal `load` event with `locals.user` + a real `request` (headers used). */
function makeLoadEvent(user: User | null) {
	return {
		request: new Request('http://localhost/settings/api-keys'),
		locals: { user, session: user ? {} : null },
		url: new URL('http://localhost/settings/api-keys')
	} as unknown as Parameters<typeof load>[0];
}

/** An action event for `?/revokeApiKey` — a form POST plus the session user. */
function makeRevokeEvent(
	fields: Record<string, string>,
	user: User | null = { name: 'A', id: 'u1' }
) {
	const request = new Request('http://localhost/settings/api-keys', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=abc' },
		body: new URLSearchParams(fields).toString()
	});
	return { request, locals: { user }, url: new URL(request.url) } as unknown as Parameters<
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

describe('/settings/api-keys load', () => {
	beforeEach(() => {
		listApiKeysForUser.mockReset();
		revokeApiKeyForUser.mockReset();
	});

	it('redirects an anonymous user to /login and lists nothing', async () => {
		try {
			await load(makeLoadEvent(null));
			expect.unreachable('expected a redirect to be thrown');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/login?redirectTo=' + encodeURIComponent('/settings/api-keys'));
			}
		}

		// An anonymous hit may never enumerate anyone's API keys.
		expect(listApiKeysForUser).not.toHaveBeenCalled();
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

describe('/settings/api-keys ?/revokeApiKey action', () => {
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
			if (isRedirect(e)) {
				expect(e.location).toBe('/login?redirectTo=' + encodeURIComponent('/settings/api-keys'));
			}
		}
		expect(revokeApiKeyForUser).not.toHaveBeenCalled();
	});
});
