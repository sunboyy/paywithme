// GET /api/v1/groups/{gid}/balances — net balance per member (PLAN §16.4, §8.1).
//
// `getGroupBalances` returns a bare `{ memberId, balance }` per member in
// SETTLEMENT-currency minor units — but the money-on-wire rule (§16.4) requires
// every amount to be self-describing, and the internal balance carries no
// currency. So we first load the group's settlement currency via
// `getGroupForUser` (which ALSO doubles as the access check: a `null` there is the
// CONFLATED 404, and an accessible group means `getGroupBalances` won't throw),
// then nest each balance as `{ amount, currency }` via `toBalanceDto`. Unpaginated
// (§16.4). Any valid key suffices (an `R` endpoint).

import { json } from '@sveltejs/kit';
import type { CurrencyCode } from '$lib/money';
import { getGroupForUser } from '$lib/server/groups';
import { getGroupBalances } from '$lib/server/balances';
import { toBalanceDto } from '$lib/server/api/v1';
import { withReadErrorHandling } from '$lib/server/api/read';
import { requireRateLimit } from '$lib/server/api/rate-limit';
import { notFound, unauthorized } from '$lib/server/api/errors';

export const GET = withReadErrorHandling(async ({ locals, params }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();

	const { gid } = params;
	if (!gid) return notFound();

	// TIER-2 read limiter (§16.7): 100/60s per key, enforced AFTER auth (the hook).
	const limited = await requireRateLimit(principal, 'read');
	if (limited) return limited;

	// The group row gives us the settlement currency the balance integers are
	// denominated in AND serves as the access gate (`null` = absent/no-access → 404).
	const group = await getGroupForUser(principal.userId, gid);
	if (!group) return notFound();

	const balances = await getGroupBalances({ userId: principal.userId, groupId: gid });
	const settlementCurrency = group.settlementCurrency as CurrencyCode;
	return json(balances.map((b) => toBalanceDto(b, settlementCurrency)));
});
