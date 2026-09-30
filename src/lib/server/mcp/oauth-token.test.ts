// Unit tests for the `/mcp` OAuth access-token check (ADR-0018).
//
// Tokens are REAL JWTs signed here with a throwaway key; only the key source
// (`auth.api.getJwks`) and the DPoP replay store are stubbed. So the signature,
// issuer, audience, expiry, `typ` and DPoP-binding checks are the library's real
// code, run against the same issuer/resource constants `auth.ts` configures.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';

const ISSUER = 'http://localhost:5173';
const RESOURCE = 'http://localhost:5173/mcp';

const { getJwks, reserveVerificationValue } = vi.hoisted(() => ({
	getJwks: vi.fn(),
	reserveVerificationValue: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({
	auth: {
		api: { getJwks },
		$context: Promise.resolve({ internalAdapter: { reserveVerificationValue } })
	},
	OAUTH_ISSUER: 'http://localhost:5173',
	MCP_RESOURCE: 'http://localhost:5173/mcp'
}));

import { verifyMcpAccessToken } from './oauth-token';

const KID = 'key-1';
let signingKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
	const pair = await generateKeyPair('EdDSA', { extractable: true });
	signingKey = pair.privateKey;
	publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'EdDSA', use: 'sig' };
});

beforeEach(() => {
	vi.clearAllMocks();
	getJwks.mockResolvedValue({ keys: [publicJwk] });
	reserveVerificationValue.mockResolvedValue(true);
});

interface TokenOptions {
	claims?: Record<string, unknown>;
	issuer?: string;
	audience?: string;
	typ?: string;
	expiresIn?: string;
	key?: CryptoKey;
	kid?: string;
}

/** An access token shaped exactly like the provider's (`createJwtAccessToken`). */
function accessToken(opts: TokenOptions = {}): Promise<string> {
	return new SignJWT({
		client_id: 'client_1',
		azp: 'client_1',
		scope: 'read write',
		...opts.claims
	})
		.setProtectedHeader({ alg: 'EdDSA', kid: opts.kid ?? KID, typ: opts.typ ?? 'at+jwt' })
		.setSubject('user_1')
		.setIssuer(opts.issuer ?? ISSUER)
		.setAudience(opts.audience ?? RESOURCE)
		.setIssuedAt()
		.setExpirationTime(opts.expiresIn ?? '1h')
		.sign(opts.key ?? signingKey);
}

function mcpRequest(authorization?: string, headers: Record<string, string> = {}): Request {
	return new Request(RESOURCE, {
		method: 'POST',
		headers: { ...(authorization ? { authorization } : {}), ...headers }
	});
}

describe('verifyMcpAccessToken — accepted tokens', () => {
	it('returns the user, client and scopes of a valid token', async () => {
		const token = await accessToken();

		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toEqual({
			userId: 'user_1',
			clientId: 'client_1',
			scopes: 'read write'
		});
		// Keys are read in-process, not fetched over HTTP from ourselves.
		expect(getJwks).toHaveBeenCalled();
	});

	it('reads an absent scope claim as no scopes (so the resolver falls to read)', async () => {
		const token = await accessToken({ claims: { scope: undefined } });

		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toMatchObject({
			scopes: ''
		});
	});
});

describe('verifyMcpAccessToken — refused tokens', () => {
	it('refuses a token for another audience (e.g. a session JWT or another resource)', async () => {
		const token = await accessToken({ audience: 'http://localhost:5173' });
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});

	it('refuses a token from another issuer', async () => {
		const token = await accessToken({ issuer: 'https://evil.example' });
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});

	it('refuses an expired token', async () => {
		const token = await accessToken({ expiresIn: '-1m' });
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});

	it('refuses a JWT that is not an access token (`typ` other than at+jwt, e.g. an ID token)', async () => {
		const token = await accessToken({ typ: 'JWT' });
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});

	it('refuses a token signed by a key not in our JWKS', async () => {
		const other = await generateKeyPair('EdDSA');
		const token = await accessToken({ key: other.privateKey, kid: 'unknown' });
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});

	it('refuses a tampered payload', async () => {
		const [header, , signature] = (await accessToken()).split('.');
		const forged = Buffer.from(
			JSON.stringify({ sub: 'someone_else', iss: ISSUER, aud: RESOURCE, exp: 9999999999 })
		).toString('base64url');
		expect(
			await verifyMcpAccessToken(mcpRequest(`Bearer ${header}.${forged}.${signature}`))
		).toBeNull();
	});

	it('refuses a client-credentials token (subject is the client itself, no user)', async () => {
		const token = await new SignJWT({ client_id: 'client_1', azp: 'client_1', scope: 'read' })
			.setProtectedHeader({ alg: 'EdDSA', kid: KID, typ: 'at+jwt' })
			.setSubject('client_1')
			.setIssuer(ISSUER)
			.setAudience(RESOURCE)
			.setExpirationTime('1h')
			.sign(signingKey);
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});

	it('returns null without touching the key set for an API key or no credential', async () => {
		expect(await verifyMcpAccessToken(mcpRequest('Bearer pwm_test_abc123'))).toBeNull();
		expect(await verifyMcpAccessToken(mcpRequest())).toBeNull();
		expect(await verifyMcpAccessToken(mcpRequest('Basic dXNlcjpwYXNz'))).toBeNull();
		expect(getJwks).not.toHaveBeenCalled();
	});

	it('returns null (never throws) when the key set cannot be read', async () => {
		getJwks.mockRejectedValue(new Error('db down'));
		const token = await accessToken({ kid: 'rotated' });
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});
});

describe('verifyMcpAccessToken — DPoP-bound tokens (RFC 9449)', () => {
	let proofKey: CryptoKey;
	let proofJwk: JWK;
	let jkt: string;

	beforeAll(async () => {
		const pair = await generateKeyPair('ES256', { extractable: true });
		proofKey = pair.privateKey;
		proofJwk = await exportJWK(pair.publicKey);
		jkt = await calculateJwkThumbprint(proofJwk, 'sha256');
	});

	async function proof(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
		return new SignJWT({
			htm: 'POST',
			htu: RESOURCE,
			jti: crypto.randomUUID(),
			ath: Buffer.from(digest).toString('base64url'),
			...overrides
		})
			.setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: proofJwk })
			.setIssuedAt()
			.sign(proofKey);
	}

	it('accepts a bound token presented with a valid proof for this request', async () => {
		const token = await accessToken({ claims: { cnf: { jkt } } });

		const result = await verifyMcpAccessToken(
			mcpRequest(`DPoP ${token}`, { dpop: await proof(token) })
		);

		expect(result).toMatchObject({ userId: 'user_1', clientId: 'client_1' });
		// The proof's jti was reserved in the shared (database) replay store.
		expect(reserveVerificationValue).toHaveBeenCalledTimes(1);
	});

	it('refuses a bound token sent as a plain Bearer token (stolen-token replay)', async () => {
		const token = await accessToken({ claims: { cnf: { jkt } } });
		expect(await verifyMcpAccessToken(mcpRequest(`Bearer ${token}`))).toBeNull();
	});

	it('refuses a proof made for a different URL', async () => {
		const token = await accessToken({ claims: { cnf: { jkt } } });
		const wrong = await proof(token, { htu: 'http://localhost:5173/api/v1/groups' });
		expect(await verifyMcpAccessToken(mcpRequest(`DPoP ${token}`, { dpop: wrong }))).toBeNull();
	});

	it('refuses a replayed proof', async () => {
		reserveVerificationValue.mockResolvedValue(false);
		const token = await accessToken({ claims: { cnf: { jkt } } });
		expect(
			await verifyMcpAccessToken(mcpRequest(`DPoP ${token}`, { dpop: await proof(token) }))
		).toBeNull();
	});
});
