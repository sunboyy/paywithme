// GET /api/v1/groups — the caller's accessible groups (PLAN §16.4).
//
// Thin wrapper over `listGroupsForUser` (which returns ONLY the groups the
// principal has an active member link to, so there is no access error — an
// inaccessible group simply never appears). Each row is projected through the
// owned `toGroupDto` mapper so the internal `deletedAt` never reaches the wire.
// Unpaginated (§16.4 — only the transactions list paginates). Any valid key
// suffices (an `R` endpoint).

import { json } from '@sveltejs/kit';
import { listGroupsForUser } from '$lib/server/groups';
import { toGroupDto } from '$lib/server/api/v1';
import { withReadErrorHandling } from '$lib/server/api/read';
import { requireRateLimit } from '$lib/server/api/rate-limit';
import { unauthorized } from '$lib/server/api/errors';

export const GET = withReadErrorHandling(async ({ locals }) => {
	// The hook guarantees a principal for `/api/v1/*` (401 otherwise); guard
	// defensively so a misconfigured route can never read `null.userId`.
	const principal = locals.apiKey;
	if (!principal) return unauthorized();

	// TIER-2 read limiter (§16.7): 100/60s per key, enforced AFTER auth (the hook).
	const limited = await requireRateLimit(principal, 'read');
	if (limited) return limited;

	const groups = await listGroupsForUser(principal.userId);
	return json(groups.map(toGroupDto));
});
