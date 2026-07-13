import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Route tests for `/settings/api-keys/new` (PLAN §16.8).
//
// The contract this file defends is the SERVER-FIRST one: a plain form POST (what
// a JS-disabled browser sends) mints the key and REDIRECTS to the reveal screen,
// with the plaintext handed over ONLY through the one-time flash cookie — never in
// the action's response body, and never in the URL.

const { createApiKeyForUser, setApiKeyReveal } = vi.hoisted(() => ({
	createApiKeyForUser: vi.fn(),
	setApiKeyReveal: vi.fn()
}));

vi.mock('$lib/server/api-keys', () => ({ createApiKeyForUser }));
vi.mock('$lib/server/api-key-reveal', () => ({ setApiKeyReveal }));

import { load, actions } from './+page.server';

const USER = { id: 'user_1', name: 'Ann' };

function makeLoadEvent(user: typeof USER | null) {
	return { locals: { user } } as unknown as Parameters<typeof load>[0];
}

/** A form-encoded POST — exactly the shape a no-JS submission arrives in. */
function makeActionEvent(fields: Record<string, string>, user: typeof USER | null = USER) {
	const request = new Request('http://localhost/settings/api-keys/new', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString()
	});
	const cookies = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
	const event = { request, locals: { user }, cookies } as unknown as Parameters<
		(typeof actions)['default']
	>[0];
	return { event, cookies };
}

/** Run the action expecting its success path — which throws a redirect. */
async function expectRedirect(event: Parameters<(typeof actions)['default']>[0]) {
	try {
		await actions.default(event);
		expect.unreachable('expected a redirect');
	} catch (e) {
		expect(isRedirect(e)).toBe(true);
	}
}

const created = {
	id: 'key_1',
	name: 'My agent',
	scope: 'read' as const,
	start: 'pwm_test_ab',
	expiresAt: null,
	key: 'pwm_test_secret-plaintext'
};

beforeEach(() => {
	createApiKeyForUser.mockReset();
	setApiKeyReveal.mockReset();
});

describe('/settings/api-keys/new load', () => {
	it('redirects an anonymous visitor to /login', async () => {
		try {
			await load(makeLoadEvent(null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('/login');
		}
	});

	it('seeds the form with the least-privilege, non-expiring defaults', async () => {
		const data = (await load(makeLoadEvent(USER))) as {
			form: { data: { scope: string; expiry: string } };
		};
		// SSR'd HTML therefore already has "Read only" + "Never" checked — the no-JS
		// user gets the right defaults with zero client code.
		expect(data.form.data.scope).toBe('read');
		expect(data.form.data.expiry).toBe('never');
	});
});

describe('/settings/api-keys/new create action', () => {
	it('mints the key from a plain form POST and redirects to the reveal screen', async () => {
		createApiKeyForUser.mockResolvedValue(created);
		const { event } = makeActionEvent({ name: 'My agent', scope: 'read', expiry: 'never' });

		try {
			await actions.default(event);
			expect.unreachable('expected a redirect to the reveal screen');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				// The secret is NOT in the URL — it travels in the httpOnly cookie.
				expect(e.location).toBe('/settings/api-keys/created');
			}
		}

		expect(createApiKeyForUser).toHaveBeenCalledWith({
			userId: USER.id,
			input: expect.objectContaining({ name: 'My agent', scope: 'read', expiry: 'never' })
		});
	});

	it('hands the ONE-TIME plaintext to the reveal cookie, and nowhere else', async () => {
		createApiKeyForUser.mockResolvedValue(created);
		const { event } = makeActionEvent({ name: 'My agent', scope: 'read', expiry: 'never' });

		// The redirect throws — that IS the success path.
		await expectRedirect(event);

		expect(setApiKeyReveal).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ id: 'key_1', key: 'pwm_test_secret-plaintext', scope: 'read' })
		);
	});

	it('forwards the write scope and a custom TTL as submitted', async () => {
		createApiKeyForUser.mockResolvedValue({ ...created, scope: 'write' });
		const { event } = makeActionEvent({
			name: 'Bot',
			scope: 'write',
			expiry: 'custom',
			customDays: '14'
		});

		await expectRedirect(event);

		expect(createApiKeyForUser).toHaveBeenCalledWith({
			userId: USER.id,
			input: expect.objectContaining({ scope: 'write', expiry: 'custom', customDays: 14 })
		});
	});

	it('fails validation (no key minted) when the name is missing', async () => {
		const { event } = makeActionEvent({ name: '', scope: 'read', expiry: 'never' });

		const result = (await actions.default(event)) as { status: number };

		expect(result.status).toBe(400);
		expect(createApiKeyForUser).not.toHaveBeenCalled();
		expect(setApiKeyReveal).not.toHaveBeenCalled();
	});

	it('fails validation when "custom" arrives without a day count', async () => {
		const { event } = makeActionEvent({ name: 'Bot', scope: 'read', expiry: 'custom' });

		const result = (await actions.default(event)) as { status: number };

		expect(result.status).toBe(400);
		expect(createApiKeyForUser).not.toHaveBeenCalled();
	});

	it('surfaces a generic error (never the raw cause) when minting fails', async () => {
		createApiKeyForUser.mockRejectedValue(new Error('plugin said no: secret leaked in message'));
		const { event } = makeActionEvent({ name: 'Bot', scope: 'read', expiry: 'never' });

		const result = (await actions.default(event)) as {
			status: number;
			data: { form: { message: { type: string; text: string } } };
		};

		expect(result.status).toBe(500);
		expect(result.data.form.message.text).toBe('Could not create that key. Please try again.');
		expect(result.data.form.message.text).not.toContain('plugin said no');
		// No reveal cookie is set for a key that was never minted.
		expect(setApiKeyReveal).not.toHaveBeenCalled();
	});

	it('redirects an anonymous POST to /login and mints nothing', async () => {
		const { event } = makeActionEvent({ name: 'Bot', scope: 'write', expiry: 'never' }, null);

		try {
			await actions.default(event);
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('/login');
		}
		expect(createApiKeyForUser).not.toHaveBeenCalled();
	});
});
