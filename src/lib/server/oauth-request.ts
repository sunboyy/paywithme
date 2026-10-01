// Verifying the OAuth provider's signature on the authorization request it
// redirects to our login page with (ADR-0018).
//
// The provider appends the request plus `ba_iat` (when it issued it) and a `sig`
// over all of it: an HMAC with the auth secret of the params sorted by key, then
// value. `/oauth/login` decides "is this session fresh enough for
// `prompt=login` / `max_age`?" by comparing the session's creation time with
// `ba_iat`. The query is in the user's hands, so `ba_iat` is trusted only when
// the signature checks out — the same check the provider makes
// (`verifyOAuthQueryParams`, which it does not export). Same primitives, same
// canonical form.
//
// `exp` is deliberately NOT enforced: an expired request is still a genuine one,
// and its `ba_iat` is still when it was issued. Freshness only needs that time.

import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import { auth } from '$lib/server/auth';

/** The provider's canonical form: entries sorted by key, then by value. */
function canonicalize(params: URLSearchParams): string {
	const entries = [...params.entries()].sort(([keyA, valueA], [keyB, valueB]) =>
		keyA < keyB ? -1 : keyA > keyB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0
	);
	return new URLSearchParams(entries).toString();
}

/**
 * When the provider issued this authorization request, or `null` if the query
 * is not exactly what the provider signed (missing, duplicated or wrong `sig`,
 * any param added, removed or edited) or carries no valid issue time.
 */
export async function verifiedRequestIssuedAt(search: URLSearchParams): Promise<Date | null> {
	const signatures = search.getAll('sig');
	if (signatures.length !== 1) return null;

	const signed = new URLSearchParams(search);
	signed.delete('sig');
	const { secret } = await auth.$context;
	const expected = await makeSignature(canonicalize(signed), secret);
	if (!constantTimeEqual(signatures[0], expected)) return null;

	const issuedAt = Number(search.get('ba_iat'));
	if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
	return new Date(issuedAt);
}
