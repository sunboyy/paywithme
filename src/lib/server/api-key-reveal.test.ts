import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import {
	API_KEY_REVEAL_COOKIE,
	API_KEY_REVEAL_COOKIE_PATH,
	API_KEY_REVEAL_MAX_AGE_SECONDS,
	setApiKeyReveal,
	takeApiKeyReveal,
	type ApiKeyReveal
} from './api-key-reveal';

// Unit tests for the one-time secret handoff (PLAN §16.8).
//
// The property under test is the one the reveal screen's warning PROMISES: the
// plaintext can be read exactly ONCE. `takeApiKeyReveal` must therefore always
// delete the cookie — including when the value is junk — and it must never trust
// a tampered payload.

/** A tiny in-memory `Cookies` double recording set/delete with their options. */
function makeCookies(initial?: string) {
	const store = new Map<string, string>();
	if (initial !== undefined) store.set(API_KEY_REVEAL_COOKIE, initial);

	const set = vi.fn((name: string, value: string) => {
		store.set(name, value);
	});
	const del = vi.fn((name: string) => {
		store.delete(name);
	});

	const cookies = {
		get: (name: string) => store.get(name),
		set,
		delete: del
	} as unknown as Cookies;

	return { cookies, set, delete: del, store };
}

const reveal: ApiKeyReveal = {
	id: 'key_1',
	name: 'My agent',
	scope: 'write',
	start: 'pwm_test_ab',
	expiresAt: null,
	key: 'pwm_test_secret-plaintext'
};

let harness: ReturnType<typeof makeCookies>;
beforeEach(() => {
	harness = makeCookies();
});

describe('setApiKeyReveal', () => {
	it('stashes the secret in an httpOnly, same-site, tightly-scoped cookie', () => {
		setApiKeyReveal(harness.cookies, reveal);

		const [name, , options] = harness.set.mock.calls[0] as unknown as [
			string,
			string,
			Record<string, unknown>
		];
		expect(name).toBe(API_KEY_REVEAL_COOKIE);
		// httpOnly: no script can read the secret out of document.cookie.
		expect(options.httpOnly).toBe(true);
		expect(options.sameSite).toBe('lax');
		// Scoped to the api-keys subtree only — it rides on nothing else.
		expect(options.path).toBe(API_KEY_REVEAL_COOKIE_PATH);
		// Short-lived backstop for a reveal screen that is never reached.
		expect(options.maxAge).toBe(API_KEY_REVEAL_MAX_AGE_SECONDS);
	});
});

describe('takeApiKeyReveal', () => {
	it('round-trips the reveal payload', () => {
		setApiKeyReveal(harness.cookies, reveal);
		expect(takeApiKeyReveal(harness.cookies)).toEqual(reveal);
	});

	it('CONSUMES the cookie: a second read returns null (shown exactly once)', () => {
		setApiKeyReveal(harness.cookies, reveal);

		expect(takeApiKeyReveal(harness.cookies)).not.toBeNull();
		// This is the whole "you won't see this again" guarantee — a refresh of the
		// reveal screen finds nothing.
		expect(takeApiKeyReveal(harness.cookies)).toBeNull();
		expect(harness.delete).toHaveBeenCalledWith(
			API_KEY_REVEAL_COOKIE,
			expect.objectContaining({ path: API_KEY_REVEAL_COOKIE_PATH })
		);
	});

	it('returns null when no key is in flight', () => {
		expect(takeApiKeyReveal(harness.cookies)).toBeNull();
	});

	it('treats a malformed / tampered value as absent AND still clears it', () => {
		for (const bad of [
			'not-json',
			JSON.stringify({ id: 'key_1' }), // no secret
			JSON.stringify({ key: 'secret' }), // no id
			JSON.stringify({ id: 'key_1', key: 'secret', scope: 'admin' }), // junk scope
			JSON.stringify(['array'])
		]) {
			const h = makeCookies(bad);
			expect(takeApiKeyReveal(h.cookies), `value: ${bad}`).toBeNull();
			// A cookie we refuse to use must not linger in the browser holding a secret.
			expect(h.delete).toHaveBeenCalled();
		}
	});
});
