import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Route tests for `/settings/api-keys/created` — the one-time reveal (PLAN §16.8).

const { takeApiKeyReveal } = vi.hoisted(() => ({ takeApiKeyReveal: vi.fn() }));
vi.mock('$lib/server/api-key-reveal', () => ({ takeApiKeyReveal }));

import { load } from './+page.server';

const USER = { id: 'user_1', name: 'Ann' };

function makeEvent(user: typeof USER | null = USER) {
	const cookies = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
	return { locals: { user }, cookies } as unknown as Parameters<typeof load>[0];
}

const reveal = {
	id: 'key_1',
	name: 'My agent',
	scope: 'write' as const,
	start: 'pwm_test_ab',
	expiresAt: null,
	key: 'pwm_test_abcdefghijklmnopqrstuvwxyz'
};

beforeEach(() => {
	takeApiKeyReveal.mockReset();
});

describe('/settings/api-keys/created load', () => {
	it('renders the secret ONCE, alongside a server-computed masked form', async () => {
		takeApiKeyReveal.mockReturnValue(reveal);

		const data = (await load(makeEvent())) as {
			key: string;
			masked: string;
			scope: string;
			name: string | null;
		};

		expect(data.key).toBe(reveal.key);
		expect(data.scope).toBe('write');
		expect(data.name).toBe('My agent');
		// The masked value is what a no-JS visitor sees by default — it must be a
		// real mask, not the secret with a different name.
		expect(data.masked).not.toBe(reveal.key);
		expect(data.masked.startsWith('pwm_test_')).toBe(true);
		expect(data.masked).not.toContain('uvwxyz');
	});

	it('CONSUMES the reveal (a refresh bounces back to Settings)', async () => {
		// `takeApiKeyReveal` deletes the flash cookie as it reads it, so the second
		// load has nothing — which is the "shown once" promise, enforced.
		takeApiKeyReveal.mockReturnValueOnce(reveal).mockReturnValue(null);

		await load(makeEvent());
		expect(takeApiKeyReveal).toHaveBeenCalledTimes(1);

		try {
			await load(makeEvent());
			expect.unreachable('expected a redirect on the second (refresh) load');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) {
				expect(e.status).toBe(303);
				expect(e.location).toBe('/settings');
			}
		}
	});

	it('redirects to /settings when the URL is opened cold (no key in flight)', async () => {
		takeApiKeyReveal.mockReturnValue(null);

		try {
			await load(makeEvent());
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('/settings');
		}
	});

	it('redirects an anonymous visitor to /login and never touches the cookie', async () => {
		try {
			await load(makeEvent(null));
			expect.unreachable('expected a redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			if (isRedirect(e)) expect(e.location).toBe('/login');
		}
		expect(takeApiKeyReveal).not.toHaveBeenCalled();
	});
});
