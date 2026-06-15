import { describe, it, expect, vi, afterEach } from 'vitest';

// Unit test for the better-auth server config (PLAN §5.1, §5.2, §5.7).
//
// We test the wiring that is checkable WITHOUT touching a real database or
// sending real email:
//   - the pure `parseTrustedOrigins` env helper (split / trim / filter), which
//     is how `AUTH_TRUSTED_ORIGINS` is turned into the array better-auth wants,
//   - that the `auth` instance constructs and registers exactly the magic-link
//     and passkey plugins with email/password disabled and no social providers,
//   - that the env-default for the WebAuthn rpID resolves to `localhost`,
//   - that the placeholder `sendMagicLink` (task 2.3 seam) is callable and logs.
//
// NOTE: under Vitest, `$env/dynamic/private` does not reflect arbitrary
// `vi.stubEnv` values set at runtime, so the env-PARSING contract is asserted
// directly through the pure `parseTrustedOrigins` helper rather than by trying
// to drive `auth.options.trustedOrigins` from a stubbed env var.

describe('parseTrustedOrigins', () => {
	it('splits a comma-separated list, trimming whitespace', async () => {
		const { parseTrustedOrigins } = await import('./auth');
		expect(parseTrustedOrigins('http://localhost:5173, https://paywithme.example.com')).toEqual([
			'http://localhost:5173',
			'https://paywithme.example.com'
		]);
	});

	it('drops empty entries (trailing comma / blank segments)', async () => {
		const { parseTrustedOrigins } = await import('./auth');
		expect(parseTrustedOrigins('http://localhost:5173,, ,')).toEqual(['http://localhost:5173']);
	});

	it('returns an empty array for undefined or empty input', async () => {
		const { parseTrustedOrigins } = await import('./auth');
		expect(parseTrustedOrigins(undefined)).toEqual([]);
		expect(parseTrustedOrigins('')).toEqual([]);
	});
});

describe('auth instance wiring', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('constructs an auth instance exposing a request handler and options', async () => {
		const { auth } = await import('./auth');
		expect(auth).toBeDefined();
		expect(typeof auth.handler).toBe('function');
		expect(auth.options).toBeDefined();
	});

	it('registers exactly the magic-link and passkey plugins', async () => {
		const { auth } = await import('./auth');
		const pluginIds = (auth.options.plugins ?? []).map((p) => p.id);
		expect(pluginIds).toContain('magic-link');
		expect(pluginIds).toContain('passkey');
		// Exactly two plugins — catches an accidental third plugin such as a
		// forbidden social provider (PLAN §5.1).
		expect(pluginIds).toHaveLength(2);
	});

	it('disables email/password and configures no social providers', async () => {
		const { auth } = await import('./auth');
		expect(auth.options.emailAndPassword?.enabled).toBe(false);
		// No social providers are configured for this passwordless app (PLAN §5.1).
		// `socialProviders` is absent from the options object entirely.
		const options = auth.options as { socialProviders?: unknown };
		expect(options.socialProviders).toBeUndefined();
	});

	it('defaults the WebAuthn rpID to "localhost" when AUTH_RP_ID is unset', async () => {
		// AUTH_RP_ID is unset in the test env, so the config falls back to the
		// `localhost` default; the passkey plugin carries that resolved rpID.
		const { auth } = await import('./auth');
		const passkeyPlugin = (auth.options.plugins ?? []).find((p) => p.id === 'passkey');
		expect(passkeyPlugin).toBeDefined();
		expect(JSON.stringify(passkeyPlugin)).toContain('localhost');
	});

	it('exposes the magic-link plugin built from the real config factory', async () => {
		const { magicLink } = await import('better-auth/plugins');
		const { auth } = await import('./auth');
		const mlPlugin = (auth.options.plugins ?? []).find((p) => p.id === 'magic-link');
		expect(mlPlugin).toBeDefined();
		expect(typeof magicLink).toBe('function');
		expect(magicLink({ sendMagicLink: async () => {} }).id).toBe('magic-link');
	});

	it('placeholder sendMagicLink (task 2.3 seam) is callable and logs the link', async () => {
		// Asserts the documented placeholder contract in auth.ts: until the Mailgun
		// helper lands in task 2.3, sendMagicLink logs the email + url and resolves.
		// We import and invoke the REAL exported `placeholderSendMagicLink` — the
		// same function wired into the magic-link plugin — so this is a regression
		// guard that fails if the placeholder changes or is removed.
		const { placeholderSendMagicLink } = await import('./auth');
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		await expect(
			placeholderSendMagicLink({ email: 'a@b.com', url: 'http://localhost:5173/verify?token=x' })
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith(
			'[auth] (placeholder) magic link for a@b.com: http://localhost:5173/verify?token=x'
		);
	});
});
