// GET /api/v1/groups/{gid}/currencies — the currencies THIS GROUP may record a
// transaction in (issue #68; PLAN §16.4, §7.5.2 "REST surface"; ADR-0014 decision 8).
//
// The seeded §7.5.1 table PLUS the group's own custom rows, keyed by DISPLAY code.
// It exists because `/api/v1` speaks display code in both directions: without this
// endpoint a client could only write a custom currency it happened to have seen on
// an existing transaction, since the opaque row key is never disclosed and the
// global `GET /currencies` — a static table — cannot list a group-scoped row.
//
// The global endpoint is UNCHANGED and stays the seeded 29: a custom currency is
// group-scoped, and two groups may define the same code for unrelated units, so
// there is no global answer to publish (ADR-0014 decisions 2 + 7).
//
// Maps to `listCurrenciesForGroup`, which is itself access-checked: membership is
// the whole authorization boundary (§12), and it throws `GroupAccessError` for both
// "no such group" and "not your group" — translated by the wrapper to the CONFLATED
// 404, exactly like every other `/groups/{gid}/…` read (§16.2 / §16.5). Unpaginated
// (§16.4 — only the transactions list paginates). Any valid key suffices (an `R`
// endpoint).

import { json } from '@sveltejs/kit';
import { listCurrenciesForGroup } from '$lib/server/currencies';
import { toGroupCurrencyDto } from '$lib/server/api/v1';
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

	// Throws `GroupAccessError` (→ 404, conflated) when the key's owner is not an
	// active member. The service returns the seeded block first in §7.5.1 order, then
	// the group's own rows alphabetically — a stable order we serve as-is.
	const rows = await listCurrenciesForGroup({ userId: principal.userId, groupId: gid });

	// The mapper emits `display_code`; the opaque row key never reaches the wire.
	return json(rows.map(toGroupCurrencyDto));
});
