// Unit tests for verifying the provider-signed authorization request (ADR-0018).
//
// `sign` below builds a query the way `@better-auth/oauth-provider` does in
// `signParams`: the request, `exp`, `ba_iat`, one `ba_param` per signed name,
// then `sig` = HMAC over the canonical (sorted) form with the auth secret. The
// live connector flow checks the same thing against the real provider.

import { describe, expect, it, vi } from 'vitest';
import { makeSignature } from 'better-auth/crypto';

const SECRET = 'test-secret-for-oauth-request-signatures';

vi.mock('$lib/server/auth', () => ({
	auth: { $context: Promise.resolve({ secret: 'test-secret-for-oauth-request-signatures' }) }
}));

import { verifiedRequestIssuedAt } from './oauth-request';

const ISSUED_AT = 1_790_863_243_267;

async function sign(
	request: Record<string, string>,
	{ issuedAt = ISSUED_AT, secret = SECRET } = {}
): Promise<URLSearchParams> {
	const params = new URLSearchParams(request);
	params.set('exp', String(Math.floor(issuedAt / 1000) + 600));
	params.set('ba_iat', String(issuedAt));
	for (const name of [...new Set([...params.keys(), 'ba_param'])].sort()) {
		params.append('ba_param', name);
	}
	const canonical = new URLSearchParams(
		[...params.entries()].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1))
	);
	params.set('sig', await makeSignature(canonical.toString(), secret));
	return params;
}

const REQUEST = {
	response_type: 'code',
	client_id: 'client_abc',
	redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
	scope: 'openid read write',
	state: 'xyz',
	prompt: 'login',
	code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
	code_challenge_method: 'S256'
};

describe('verifiedRequestIssuedAt', () => {
	it('returns the issue time of a request the provider signed', async () => {
		expect(await verifiedRequestIssuedAt(await sign(REQUEST))).toEqual(new Date(ISSUED_AT));
	});

	it('does not depend on param order (the signature is over the sorted form)', async () => {
		const signed = await sign(REQUEST);
		const shuffled = new URLSearchParams([...signed.entries()].reverse());
		expect(await verifiedRequestIssuedAt(shuffled)).toEqual(new Date(ISSUED_AT));
	});

	it('refuses a forged issue time (the reviewed bypass)', async () => {
		const forged = await sign(REQUEST);
		forged.set('ba_iat', '1');
		expect(await verifiedRequestIssuedAt(forged)).toBeNull();
	});

	it('refuses any other edited, added or removed param', async () => {
		const edited = await sign(REQUEST);
		edited.set('prompt', 'consent');
		expect(await verifiedRequestIssuedAt(edited)).toBeNull();

		const added = await sign(REQUEST);
		added.append('max_age', '0');
		expect(await verifiedRequestIssuedAt(added)).toBeNull();

		const removed = await sign(REQUEST);
		removed.delete('state');
		expect(await verifiedRequestIssuedAt(removed)).toBeNull();
	});

	it('refuses a missing, duplicated or foreign signature', async () => {
		const unsigned = await sign(REQUEST);
		unsigned.delete('sig');
		expect(await verifiedRequestIssuedAt(unsigned)).toBeNull();

		const doubled = await sign(REQUEST);
		doubled.append('sig', doubled.get('sig')!);
		expect(await verifiedRequestIssuedAt(doubled)).toBeNull();

		expect(
			await verifiedRequestIssuedAt(await sign(REQUEST, { secret: 'another-deployment' }))
		).toBeNull();
	});

	it('still accepts an expired request: its issue time is genuine', async () => {
		const longAgo = await sign(REQUEST, { issuedAt: ISSUED_AT - 24 * 3600 * 1000 });
		expect(await verifiedRequestIssuedAt(longAgo)).toEqual(new Date(ISSUED_AT - 24 * 3600 * 1000));
	});
});
