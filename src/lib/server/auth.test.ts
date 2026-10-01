import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';

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

// The first import of `./auth` loads better-auth and every plugin (including the
// OAuth provider) cold. Under a parallel run that can approach the 5s per-test
// limit, so load it once here with room to spare; every test's own
// `await import('./auth')` then hits the module cache.
beforeAll(async () => {
	await import('./auth');
}, 30_000);

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

	it('Vercel preview → binds auth to the branch URL instead of the production origin', async () => {
		const { resolveAuthEnv } = await import('./auth');
		const resolved = resolveAuthEnv({
			env: {
				...PROD_ENV,
				VERCEL_ENV: 'preview',
				VERCEL_BRANCH_URL: 'paywithme-git-feat-x-team.vercel.app',
				VERCEL_URL: 'paywithme-abc123-team.vercel.app'
			},
			isProduction: true
		});
		expect(resolved).toEqual({
			baseURL: 'https://paywithme-git-feat-x-team.vercel.app',
			rpID: 'paywithme-git-feat-x-team.vercel.app',
			origin: 'https://paywithme-git-feat-x-team.vercel.app',
			trustedOrigins: [
				'https://paywithme-git-feat-x-team.vercel.app',
				'https://paywithme-abc123-team.vercel.app'
			],
			secret: 'super-secret-value-do-not-leak'
		});
	});

	it('Vercel preview without origin vars → only the secret is required', async () => {
		const { resolveAuthEnv } = await import('./auth');
		const resolved = resolveAuthEnv({
			env: {
				BETTER_AUTH_SECRET: 'preview-secret',
				VERCEL_ENV: 'preview',
				VERCEL_BRANCH_URL: 'paywithme-git-feat-x-team.vercel.app'
			},
			isProduction: true
		});
		expect(resolved.baseURL).toBe('https://paywithme-git-feat-x-team.vercel.app');
		expect(resolved.trustedOrigins).toEqual(['https://paywithme-git-feat-x-team.vercel.app']);
	});

	it('Vercel preview without VERCEL_BRANCH_URL → throws instead of using the production origin', async () => {
		const { resolveAuthEnv } = await import('./auth');
		expect(() =>
			resolveAuthEnv({ env: { ...PROD_ENV, VERCEL_ENV: 'preview' }, isProduction: true })
		).toThrow(/VERCEL_BRANCH_URL/);
	});

	it('Vercel production → keeps the configured production origin', async () => {
		const { resolveAuthEnv } = await import('./auth');
		const resolved = resolveAuthEnv({
			env: {
				...PROD_ENV,
				VERCEL_ENV: 'production',
				VERCEL_BRANCH_URL: 'paywithme-git-main-team.vercel.app'
			},
			isProduction: true
		});
		expect(resolved.baseURL).toBe('https://paywithme.example.com');
		expect(resolved.rpID).toBe('paywithme.example.com');
	});
});

describe('resolveApiKeyPrefix (env-scoped key prefix — PLAN §16.1)', () => {
	// Pure function: we pass the `isProduction` flag directly, so these tests never
	// touch the real env. The trailing underscore is the plugin's identifiable-prefix
	// convention.
	it('uses the `pwm_live_` prefix in production', async () => {
		const { resolveApiKeyPrefix } = await import('./auth');
		expect(resolveApiKeyPrefix({ isProduction: true })).toBe('pwm_live_');
	});

	it('uses the `pwm_test_` prefix in dev/test/preview', async () => {
		const { resolveApiKeyPrefix } = await import('./auth');
		expect(resolveApiKeyPrefix({ isProduction: false })).toBe('pwm_test_');
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

	it('registers exactly the magic-link, passkey, api-key, jwt, oauth-provider, and sveltekit-cookies plugins', async () => {
		const { auth } = await import('./auth');
		const pluginIds = (auth.options.plugins ?? []).map((p) => p.id);
		expect(pluginIds).toContain('magic-link');
		expect(pluginIds).toContain('passkey');
		// `api-key` (PLAN §16.1) exposes the server-side key API for later tickets.
		expect(pluginIds).toContain('api-key');
		// `jwt` signs the connector's OAuth access tokens (ADR-0018).
		expect(pluginIds).toContain('jwt');
		// `mcp()` from `@better-auth/mcp` IS the oauth-provider plugin, preset for MCP
		// (ADR-0010, ADR-0018), so it registers under that id.
		expect(pluginIds).toContain('oauth-provider');
		// `sveltekit-cookies` (added in task 2.10) makes server-side `auth.api.*`
		// calls route their Set-Cookie through SvelteKit so cleared/refreshed
		// session cookies reach the browser (e.g. logout). It MUST stay last.
		expect(pluginIds).toContain('sveltekit-cookies');
		// Exactly these six — asserting the exact set still catches an accidental
		// extra plugin such as a forbidden social provider (PLAN §5.1).
		expect(pluginIds).toHaveLength(6);
		expect(new Set(pluginIds)).toEqual(
			new Set(['magic-link', 'passkey', 'api-key', 'jwt', 'oauth-provider', 'sveltekit-cookies'])
		);
	});

	it('registers jwt and the OAuth provider BEFORE sveltekit-cookies, with sveltekit-cookies last', async () => {
		const { auth } = await import('./auth');
		const pluginIds = (auth.options.plugins ?? []).map((p) => p.id);
		const cookiesIndex = pluginIds.indexOf('sveltekit-cookies');
		for (const id of ['jwt', 'oauth-provider'] as const) {
			expect(pluginIds.indexOf(id)).toBeGreaterThanOrEqual(0);
			expect(pluginIds.indexOf(id)).toBeLessThan(cookiesIndex);
		}
		// sveltekit-cookies stays LAST (better-auth requirement).
		expect(cookiesIndex).toBe(pluginIds.length - 1);
	});

	/** The registered OAuth provider's resolved options. */
	async function oauthProviderOptions() {
		const { auth } = await import('./auth');
		const plugin = (auth.options.plugins ?? []).find((p) => p.id === 'oauth-provider') as
			| {
					options?: {
						loginPage?: string;
						consentPage?: string;
						scopes?: string[];
						advertisedMetadata?: { scopes_supported?: string[] };
						resources?: unknown[];
						allowDynamicClientRegistration?: boolean;
						allowUnauthenticatedClientRegistration?: boolean;
					};
			  }
			| undefined;
		expect(plugin).toBeDefined();
		return plugin!.options ?? {};
	}

	it('configures the OAuth login page as the dedicated /oauth/login (ADR-0010 §Decision(1))', async () => {
		// The AS redirects an unauthenticated resource-owner to this DEDICATED login
		// surface (not the everyday /login) to establish a session before the
		// authorization/consent step; that page then resumes the authorization.
		expect((await oauthProviderOptions()).loginPage).toBe('/oauth/login');
	});

	it('grants and advertises read/write, with a consent page (ADR-0010 §Decision(4), #41)', async () => {
		const { OAUTH_CONSENT_PATH } = await import('./auth');
		const options = await oauthProviderOptions();
		const expected = ['openid', 'profile', 'email', 'offline_access', 'read', 'write'];
		// GRANTABLE: `/oauth2/authorize` refuses any scope outside this set
		// (`invalid_scope`). An accidental extra scope must fail HERE.
		expect(options.scopes).toEqual(expected);
		// ADVERTISED in discovery, so a connector can find out read/write exist.
		expect(options.advertisedMetadata?.scopes_supported).toEqual(expected);
		// The conscious read/write consent choice (ADR-0007) is reproduced at this
		// route — and the config points at the SAME literal the route lives at.
		expect(options.consentPage).toBe(OAUTH_CONSENT_PATH);
		expect(OAUTH_CONSENT_PATH).toBe('/oauth/consent');
	});

	it('lets a connector register itself: unauthenticated dynamic client registration is on', async () => {
		// Claude.ai self-registers (RFC 7591) before it can start the flow. With
		// either flag off, the connector fails at "Connect".
		const options = await oauthProviderOptions();
		expect(options.allowDynamicClientRegistration).toBe(true);
		expect(options.allowUnauthenticatedClientRegistration).toBe(true);
	});

	it('binds tokens to the /mcp resource on the app origin, which is also the issuer', async () => {
		const { MCP_RESOURCE, OAUTH_ISSUER } = await import('./auth');
		// The server test project pins BETTER_AUTH_URL=http://localhost:5173.
		expect(OAUTH_ISSUER).toBe('http://localhost:5173');
		expect(MCP_RESOURCE).toBe('http://localhost:5173/mcp');
		expect((await oauthProviderOptions()).resources).toContain(MCP_RESOURCE);
	});

	it('pins the jwt issuer to the app origin and keeps the session-JWT surface off', async () => {
		const { auth, OAUTH_ISSUER } = await import('./auth');
		const jwtPlugin = (auth.options.plugins ?? []).find((p) => p.id === 'jwt') as {
			options?: { jwt?: { issuer?: string }; disableSettingJwtHeader?: boolean };
		};
		// `/mcp` verifies `iss` against OAUTH_ISSUER, and RFC 8414 discovery lives
		// at the root because the issuer has no path.
		expect(jwtPlugin.options?.jwt?.issuer).toBe(OAUTH_ISSUER);
		// No `set-auth-jwt` header on session responses, and no `/token` endpoint.
		expect(jwtPlugin.options?.disableSettingJwtHeader).toBe(true);
		expect(auth.options.disabledPaths).toContain('/token');
	});

	it('builds its context with no database: the OAuth resource seed is deferred, not fatal', async () => {
		// The provider seeds `oauth_resource` during init, inside better-auth's
		// one-shot `$context` promise. The unit-test project has no DATABASE_URL, so
		// this is the "database unreachable at startup" case: `$context` must still
		// resolve, or every auth request on the instance would fail
		// (`deferResourceSeedFailure` in auth.ts).
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// A FRESH instance, so its init runs under the spy.
		vi.resetModules();
		const { auth } = await import('./auth');
		await expect(auth.$context).resolves.toBeDefined();
		expect(warn).toHaveBeenCalledWith(
			'[auth] OAuth resource seed deferred to first use:',
			expect.any(Error)
		);
		warn.mockRestore();
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

	it('stamps the §16.7 TIER-1 rate-limit backstop (150 req / 60s) onto every key at creation', async () => {
		// The plugin threads the config-level `rateLimit` defaults into its `apikey`
		// schema field defaults (`rateLimitMax.defaultValue` / `rateLimitTimeWindow.
		// defaultValue`), which `createApiKey` writes onto each key
		// (`rateLimitMax ?? opts.rateLimit.maxRequests`, etc.). Asserting the schema
		// defaults proves the backstop is applied at creation WITHOUT touching a DB.
		const { auth } = await import('./auth');
		const apiKeyPlugin = (auth.options.plugins ?? []).find((p) => p.id === 'api-key') as {
			schema?: { apikey?: { fields?: Record<string, { defaultValue?: unknown }> } };
		};
		const fields = apiKeyPlugin.schema?.apikey?.fields ?? {};
		// Combined 150/60s (§16.7): sized ABOVE the tier-2 read 100 + write 20 burst.
		expect(fields.rateLimitMax?.defaultValue).toBe(150);
		expect(fields.rateLimitTimeWindow?.defaultValue).toBe(60_000);
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
