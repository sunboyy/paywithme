// GET /api/v1/groups/{gid} — a single accessible group (PLAN §16.4).
//
// `getGroupForUser` returns the group only when the principal has access and it
// isn't soft-deleted, else `null` — which we map to the CONFLATED 404 `not_found`
// (no-access and absent are indistinguishable, PLAN §16.5 / §12). The group is
// projected through `toGroupDto` so `deletedAt` never reaches the wire. Any valid
// key suffices (an `R` endpoint).

import { json } from '@sveltejs/kit';
import { getGroupForUser } from '$lib/server/groups';
import { toGroupDto } from '$lib/server/api/v1';
import { withReadErrorHandling } from '$lib/server/api/read';
import { notFound, unauthorized } from '$lib/server/api/errors';

export const GET = withReadErrorHandling(async ({ locals, params }) => {
	const principal = locals.apiKey;
	if (!principal) return unauthorized();

	const { gid } = params;
	if (!gid) return notFound();

	const group = await getGroupForUser(principal.userId, gid);
	// `null` = absent OR no-access — one indistinguishable 404 (§16.5 / §12).
	if (!group) return notFound();

	return json(toGroupDto(group));
});
