// GET /api/v1/groups/{gid}/members — a group's roster (PLAN §16.4).
//
// `listMembers` is access-checked: it throws `GroupAccessError` on no access,
// which `withReadErrorHandling` translates to the CONFLATED 404 `not_found` (so a
// no-access group is indistinguishable from an absent one, PLAN §16.5 / §12). The
// roster includes deactivated members (each carries `deactivatedAt` / `isLinked`);
// every row is projected through `toMemberDto`. Unpaginated (§16.4). Any valid key
// suffices (an `R` endpoint).

import { json } from '@sveltejs/kit';
import { listMembers } from '$lib/server/members';
import { toMemberDto } from '$lib/server/api/v1';
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

	// Throws `GroupAccessError` (→ 404) on no access — mapped by the wrapper.
	const members = await listMembers({ userId: principal.userId, groupId: gid });
	return json(members.map(toMemberDto));
});
