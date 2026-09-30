// Unit tests for `/mcp` dual-auth resolution (ADR-0010 §Decision(3)).
//
// `resolveMcpAuth` is the ONE place that knows OAuth-vs-key: it tries the OAuth
// access token first and falls back to the api-key path, converging both on a
// single `ApiKeyPrincipal`. These tests drive it with `verifyMcpAccessToken`
// and `auth.api.verifyApiKey` mocked, asserting the branch precedence, the
// scope derivation, and that only the key path rate-limits.
//
// The OAuth token check itself (JWT signature / issuer / audience / DPoP) is
// `oauth-token.ts`, tested on its own; here it is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyMcpAccessToken, verifyApiKey } = vi.hoisted(() => ({
	verifyMcpAccessToken: vi.fn(),
	verifyApiKey: vi.fn()
}));

vi.mock('./oauth-token', () => ({ verifyMcpAccessToken }));
vi.mock('$lib/server/auth', () => ({ auth: { api: { verifyApiKey } } }));

import { resolveMcpAuth, oauthScopesToPermissions } from './auth';

/** A verified access token, as `verifyMcpAccessToken` returns it. */
const OAUTH_TOKEN = {
	clientId: 'client_1',
	userId: 'user_oauth',
	scopes: 'read'
};

/** A verified read key as `verifyApiKey` returns it. */
const VALID_KEY = {
	valid: true,
	key: { id: 'key_1', name: 'Claude Code', referenceId: 'user_1', permissions: { api: ['read'] } }
};

function req(authorization?: string): Request {
	const headers = new Headers();
	if (authorization) headers.set('authorization', authorization);
	return new Request('http://localhost/mcp', { method: 'POST', headers });
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyMcpAccessToken.mockResolvedValue(null);
	verifyApiKey.mockResolvedValue(VALID_KEY);
});

describe('oauthScopesToPermissions — scope derivation (least privilege)', () => {
	it('derives WRITE from a space-separated set containing `write`', () => {
		expect(oauthScopesToPermissions('read write')).toEqual({ api: ['read', 'write'] });
		// Order / extra tokens do not matter — presence of `write` is what counts.
		expect(oauthScopesToPermissions('write')).toEqual({ api: ['read', 'write'] });
		expect(oauthScopesToPermissions('openid write profile')).toEqual({ api: ['read', 'write'] });
	});

	it('derives READ for `read`, an empty set, unknown scopes, or null/undefined', () => {
		expect(oauthScopesToPermissions('read')).toEqual({ api: ['read'] });
		expect(oauthScopesToPermissions('')).toEqual({ api: ['read'] });
		expect(oauthScopesToPermissions('openid profile')).toEqual({ api: ['read'] });
		expect(oauthScopesToPermissions(null)).toEqual({ api: ['read'] });
		expect(oauthScopesToPermissions(undefined)).toEqual({ api: ['read'] });
	});

	it('does not treat a substring like `writer` as the write scope', () => {
		expect(oauthScopesToPermissions('read writer')).toEqual({ api: ['read'] });
	});
});

describe('resolveMcpAuth — OAuth branch (tried first)', () => {
	it('resolves a WRITE-scoped token to a write principal built from the token', async () => {
		verifyMcpAccessToken.mockResolvedValue({ ...OAUTH_TOKEN, scopes: 'read write' });

		const result = await resolveMcpAuth(req('Bearer oat_abc'));

		expect(result).toEqual({
			ok: true,
			principal: {
				// Composed `${clientId}:${userId}` — unique per human caller (see below).
				keyId: 'client_1:user_oauth',
				name: null,
				userId: 'user_oauth',
				permissions: { api: ['read', 'write'] },
				// #42: the RAW client id, carried as audit provenance (`viaOAuth`).
				oauthClientId: 'client_1'
			}
		});
		// OAuth resolved — the key path was never consulted.
		expect(verifyApiKey).not.toHaveBeenCalled();
	});

	it('sets `oauthClientId` to the token’s RAW clientId — the audit actor tag (#42)', async () => {
		// ADR-0010 §Consequences: an OAuth-originated mutation needs a `viaOAuth` actor
		// tag. That tag is the BARE client id (the connected app), NOT the composed
		// `keyId`, so `auditVia` can record HOW the change entered.
		verifyMcpAccessToken.mockResolvedValue({
			...OAUTH_TOKEN,
			clientId: 'app_xyz',
			userId: 'user_z'
		});

		const result = await resolveMcpAuth(req('Bearer oat_abc'));

		expect(result).toMatchObject({ ok: true, principal: { oauthClientId: 'app_xyz' } });
		// It is the raw client id, distinct from the composed per-caller keyId.
		expect(result.ok && result.principal.oauthClientId).toBe('app_xyz');
		expect(result.ok && result.principal.keyId).toBe('app_xyz:user_z');
	});

	it('resolves a READ-only token to a read principal', async () => {
		verifyMcpAccessToken.mockResolvedValue({ ...OAUTH_TOKEN, scopes: 'read' });

		const result = await resolveMcpAuth(req('Bearer oat_abc'));

		expect(result).toMatchObject({ ok: true, principal: { permissions: { api: ['read'] } } });
		expect(verifyApiKey).not.toHaveBeenCalled();
	});

	it('keyId is PER-CALLER: same client, different users → distinct keyId (tenant isolation)', async () => {
		// `clientId` identifies the connector APP, shared by every human using it. If
		// `keyId` were `clientId` alone, two users' identical writes would dedup into one
		// (cross-tenant leak) and share a rate-limit bucket. It must fold in `userId`.
		verifyMcpAccessToken.mockResolvedValue({ ...OAUTH_TOKEN, clientId: 'app_1', userId: 'user_a' });
		const a = await resolveMcpAuth(req('Bearer oat_a'));

		verifyMcpAccessToken.mockResolvedValue({ ...OAUTH_TOKEN, clientId: 'app_1', userId: 'user_b' });
		const b = await resolveMcpAuth(req('Bearer oat_b'));

		const keyIdOf = (r: Awaited<ReturnType<typeof resolveMcpAuth>>) =>
			r.ok ? r.principal.keyId : null;
		expect(keyIdOf(a)).toBe('app_1:user_a');
		expect(keyIdOf(b)).toBe('app_1:user_b');
		expect(keyIdOf(a)).not.toBe(keyIdOf(b));
	});
});

describe('resolveMcpAuth — api-key fallback', () => {
	it('falls back to verifyBearerKey when there is no valid OAuth token', async () => {
		verifyMcpAccessToken.mockResolvedValue(null);

		const result = await resolveMcpAuth(req('Bearer pwm_valid'));

		expect(result).toEqual({
			ok: true,
			principal: {
				keyId: 'key_1',
				name: 'Claude Code',
				userId: 'user_1',
				permissions: { api: ['read'] }
			}
		});
		expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: 'pwm_valid' } });
	});

	it('surfaces the key path rate-limit outcome verbatim (only the key path rate-limits)', async () => {
		verifyApiKey.mockResolvedValue({
			valid: false,
			error: { code: 'RATE_LIMITED', details: { tryAgainIn: 30_000 } }
		});

		const result = await resolveMcpAuth(req('Bearer pwm_valid'));

		expect(result).toEqual({ ok: false, reason: 'rate_limited', tryAgainInMs: 30_000 });
	});

	it('is unauthorized when there is neither an OAuth token nor a valid key', async () => {
		verifyApiKey.mockResolvedValue({ valid: false, error: { code: 'INVALID_API_KEY' } });

		const result = await resolveMcpAuth(req());

		expect(result).toEqual({ ok: false, reason: 'unauthorized' });
	});
});
