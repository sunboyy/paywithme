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
//   - that the `sendMagicLink` callback routes through the `lib/server/email`
//     helper (`sendMagicLinkEmail`) rather than emailing directly. The email
//     helper's own behaviour (Mailgun POST + dev fallback) is covered in
//     `email.test.ts`.
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

describe('resolveAuthEnv (strict per environment — PLAN §12)', () => {
	// Pure function: we pass a fake `env` slice + `isProduction` flag, so these
	// tests never mutate the real process.env / $env.
	const PROD_ENV = {
		BETTER_AUTH_URL: 'https://paywithme.example.com',
		BETTER_AUTH_SECRET: 'super-secret-value-do-not-leak',
		AUTH_RP_ID: 'paywithme.example.com',
		AUTH_TRUSTED_ORIGINS: 'https://paywithme.example.com'
	};

	it('production + all required vars present → resolved values (rpID from env, origin = BETTER_AUTH_URL)', async () => {
		const { resolveAuthEnv } = await import('./auth');
		const resolved = resolveAuthEnv({ env: PROD_ENV, isProduction: true });
		expect(resolved).toEqual({
			baseURL: 'https://paywithme.example.com',
			rpID: 'paywithme.example.com',
			origin: 'https://paywithme.example.com',
			trustedOrigins: ['https://paywithme.example.com'],
			secret: 'super-secret-value-do-not-leak'
		});
	});

	it.each([
		['BETTER_AUTH_URL', { ...PROD_ENV, BETTER_AUTH_URL: undefined }],
		['BETTER_AUTH_SECRET', { ...PROD_ENV, BETTER_AUTH_SECRET: undefined }],
		['AUTH_RP_ID', { ...PROD_ENV, AUTH_RP_ID: undefined }],
		['AUTH_TRUSTED_ORIGINS', { ...PROD_ENV, AUTH_TRUSTED_ORIGINS: '' }]
	])(
		'production + missing %s → throws, naming the var but no secret value',
		async (missing, env) => {
			const { resolveAuthEnv } = await import('./auth');
			let thrown: Error | undefined;
			try {
				resolveAuthEnv({ env, isProduction: true });
			} catch (e) {
				thrown = e as Error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(thrown?.message).toContain(missing);
			// The message must never leak the secret value.
			expect(thrown?.message).not.toContain('super-secret-value-do-not-leak');
		}
	);

	it('production reports every missing required var at once', async () => {
		const { resolveAuthEnv } = await import('./auth');
		expect(() => resolveAuthEnv({ env: {}, isProduction: true })).toThrow(
			/BETTER_AUTH_URL.*BETTER_AUTH_SECRET.*AUTH_RP_ID.*AUTH_TRUSTED_ORIGINS/s
		);
	});

	it('dev + nothing set → lenient fallbacks (rpID "localhost"), no throw', async () => {
		const { resolveAuthEnv } = await import('./auth');
		const resolved = resolveAuthEnv({ env: {}, isProduction: false });
		expect(resolved).toEqual({
			baseURL: undefined,
			rpID: 'localhost',
			origin: null,
			trustedOrigins: [],
			secret: undefined
		});
	});

	it('dev still honours provided values when present', async () => {
		const { resolveAuthEnv } = await import('./auth');
		const resolved = resolveAuthEnv({
			env: {
				BETTER_AUTH_URL: 'http://localhost:5173',
				AUTH_TRUSTED_ORIGINS: 'http://localhost:5173'
			},
			isProduction: false
		});
		expect(resolved.baseURL).toBe('http://localhost:5173');
		expect(resolved.origin).toBe('http://localhost:5173');
		expect(resolved.rpID).toBe('localhost');
		expect(resolved.trustedOrigins).toEqual(['http://localhost:5173']);
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

	it('registers exactly the magic-link, passkey, api-key, and sveltekit-cookies plugins', async () => {
		const { auth } = await import('./auth');
		const pluginIds = (auth.options.plugins ?? []).map((p) => p.id);
		expect(pluginIds).toContain('magic-link');
		expect(pluginIds).toContain('passkey');
		// `api-key` (PLAN §16.1) exposes the server-side key API for later tickets.
		expect(pluginIds).toContain('api-key');
		// `sveltekit-cookies` (added in task 2.10) makes server-side `auth.api.*`
		// calls route their Set-Cookie through SvelteKit so cleared/refreshed
		// session cookies reach the browser (e.g. logout). It MUST stay last.
		expect(pluginIds).toContain('sveltekit-cookies');
		// Exactly these four — asserting the exact set still catches an accidental
		// extra plugin such as a forbidden social provider (PLAN §5.1).
		expect(pluginIds).toHaveLength(4);
		expect(new Set(pluginIds)).toEqual(
			new Set(['magic-link', 'passkey', 'api-key', 'sveltekit-cookies'])
		);
	});

	it('registers the api-key plugin BEFORE sveltekit-cookies, with sveltekit-cookies last (PLAN §16.1)', async () => {
		const { auth } = await import('./auth');
		const pluginIds = (auth.options.plugins ?? []).map((p) => p.id);
		const apiKeyIndex = pluginIds.indexOf('api-key');
		const cookiesIndex = pluginIds.indexOf('sveltekit-cookies');
		expect(apiKeyIndex).toBeGreaterThanOrEqual(0);
		// api-key comes before sveltekit-cookies…
		expect(apiKeyIndex).toBeLessThan(cookiesIndex);
		// …and sveltekit-cookies stays LAST (better-auth requirement).
		expect(cookiesIndex).toBe(pluginIds.length - 1);
	});

	it('keeps enableSessionForAPIKeys OFF (not-for-production — PLAN §16.1)', async () => {
		// A valid API key must NOT auto-mock a session; the app resolves keys
		// explicitly (§16.4). The option is absent-or-false either way, so assert it
		// is not truthy on the registered plugin's serialized options.
		const { auth } = await import('./auth');
		const apiKeyPlugin = (auth.options.plugins ?? []).find((p) => p.id === 'api-key');
		expect(apiKeyPlugin).toBeDefined();
		// The plugin default is false; we also pass it explicitly. Either way it must
		// never serialize as enabled.
		expect(JSON.stringify(apiKeyPlugin)).not.toContain('"enableSessionForAPIKeys":true');
	});

	it('disables email/password and configures no social providers', async () => {
		const { auth } = await import('./auth');
		expect(auth.options.emailAndPassword?.enabled).toBe(false);
		// No social providers are configured for this passwordless app (PLAN §5.1).
		// `socialProviders` is absent from the options object entirely.
		const options = auth.options as { socialProviders?: unknown };
		expect(options.socialProviders).toBeUndefined();
	});

	it('enables rate limiting in every environment with the magic-link custom rules (PLAN §12)', async () => {
		const { auth } = await import('./auth');
		const rateLimit = auth.options.rateLimit;
		expect(rateLimit).toBeDefined();
		// Always-on (better-auth otherwise enables it only in production).
		expect(rateLimit?.enabled).toBe(true);
		// Postgres-backed store (task 2.11 hardening): counters persist in the
		// `rate_limit` table and are shared across serverless instances, instead of
		// the per-instance in-memory default. Backed by `db/rate-limit-schema.ts`.
		expect(rateLimit?.storage).toBe('database');
		// Sane global fallback bucket.
		expect(typeof rateLimit?.window).toBe('number');
		expect(typeof rateLimit?.max).toBe('number');
		expect(rateLimit?.max).toBeGreaterThan(0);

		// Tightened, IP+path keyed rule for the magic-link SEND and VERIFY paths —
		// the email-bombing surface (PLAN §12). Read the resolved option, don't
		// re-derive the constant. max must stay >= 5 so the auth e2e (task 2.12)
		// can still make a few unique sends.
		const customRules = rateLimit?.customRules ?? {};
		const sendRule = customRules['/sign-in/magic-link'];
		const verifyRule = customRules['/magic-link/verify'];
		expect(sendRule).toEqual({ window: 60, max: 5 });
		expect(verifyRule).toEqual({ window: 60, max: 5 });
		expect((sendRule as { max: number }).max).toBeGreaterThanOrEqual(5);
		// Passkey sign-in challenge is also throttled (cheap to cover).
		expect(customRules['/passkey/verify-authentication']).toEqual({ window: 60, max: 10 });
	});

	it('trusts the spoof-resistant Vercel client-IP header first for rate-limit bucketing (PLAN §12)', async () => {
		// better-auth keys its rate limiter on the client IP, taking the FIRST valid
		// IP from `advanced.ipAddress.ipAddressHeaders` (read as
		// `value.split(',')[0]`). The trusted/first header must be Vercel's
		// non-spoofable, single-value `x-real-ip` so an attacker can't rotate a
		// client-supplied `x-forwarded-for` to mint fresh buckets (task 2.11).
		const { auth } = await import('./auth');
		const ipAddress = (
			auth.options.advanced as { ipAddress?: { ipAddressHeaders?: string[] } } | undefined
		)?.ipAddress;
		expect(ipAddress?.ipAddressHeaders).toEqual(['x-real-ip', 'x-forwarded-for']);
		// The trusted (first) header is the spoof-resistant Vercel-set one.
		expect(ipAddress?.ipAddressHeaders?.[0]).toBe('x-real-ip');
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

	it('sendMagicLink routes through the lib/server/email helper', async () => {
		// The exported `sendMagicLink` (the exact function wired into the magic-link
		// plugin) must delegate to `sendMagicLinkEmail` from `./email`, mapping
		// `email` → `to` and forwarding the `url`. We mock the email module so this
		// stays a wiring assertion; the helper's Mailgun/dev-fallback behaviour is
		// covered in email.test.ts.
		vi.resetModules();
		const sendMagicLinkEmail = vi.fn().mockResolvedValue(undefined);
		vi.doMock('./email', () => ({ sendMagicLinkEmail }));

		const { sendMagicLink } = await import('./auth');
		await expect(
			sendMagicLink({ email: 'a@b.com', url: 'http://localhost:5173/verify?token=x' })
		).resolves.toBeUndefined();

		expect(sendMagicLinkEmail).toHaveBeenCalledTimes(1);
		expect(sendMagicLinkEmail).toHaveBeenCalledWith({
			to: 'a@b.com',
			url: 'http://localhost:5173/verify?token=x'
		});

		vi.doUnmock('./email');
		vi.resetModules();
	});
});
