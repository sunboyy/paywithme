// GET /api/v1/currencies — the static supported-currency reference table
// (PLAN §16.4, §7.5.1).
//
// The single place an API client discovers per-currency `exponent` (minor-unit
// scale) + `symbol`, so the money-on-wire `{ amount, currency }` shape can stay
// small (no per-amount exponent/display — see `api/v1/money.ts`). Served straight
// from the canonical `$lib/money` `CURRENCIES` data, projecting to EXACTLY the
// documented `{ code, exponent, symbol }` DTO and DROPPING the internal `name`
// (a UI label, not part of this reference contract). Unpaginated (§16.4 — only
// the transactions list paginates). Any valid key suffices (an `R` endpoint).

import { json } from '@sveltejs/kit';
import { CURRENCIES } from '$lib/money';
import { withReadErrorHandling } from '$lib/server/api/read';
import { requireRateLimit } from '$lib/server/api/rate-limit';
import { unauthorized } from '$lib/server/api/errors';

/** The wire shape of one currency (§16.4): the reference triple only. */
interface CurrencyDto {
	readonly code: string;
	readonly exponent: number;
	readonly symbol: string;
}

export const GET = withReadErrorHandling(async ({ locals }) => {
	// Static reference data, but still an authenticated `R` endpoint: the hook
	// guarantees a principal (401 otherwise). Guard defensively, then apply the
	// TIER-2 read limiter (§16.7): 100/60s per key.
	const principal = locals.apiKey;
	if (!principal) return unauthorized();

	const limited = await requireRateLimit(principal, 'read');
	if (limited) return limited;

	const data: CurrencyDto[] = CURRENCIES.map((c) => ({
		code: c.code,
		exponent: c.exponent,
		symbol: c.symbol
	}));
	return json(data);
});
