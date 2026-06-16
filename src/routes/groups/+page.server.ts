// `/groups` dashboard server logic (PLAN §6, §10).
//
// Server-first: `load` lists the authenticated user's accessible groups via the
// task-3.3 group service (`listGroupsForUser`) — this route NEVER reimplements
// group logic. Anonymous hits go to login.
//
// SCOPE NOTE — balances are DEFERRED: PLAN §10 shows net balances per member on
// the dashboard, but those depend on Phase 4 transactions + Phase 5 balance math
// (task 5.1). For now the cards show name + settlement currency only; no balance
// figure is computed or displayed here.

import { redirect } from '@sveltejs/kit';
import { listGroupsForUser } from '$lib/server/groups';
import type { Group } from '$lib/server/groups';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// The dashboard is per-user (it lists the caller's own groups), so an
	// anonymous request goes to login. `redirect()` THROWS, so it lives OUTSIDE
	// the try/catch below or the catch would swallow the navigation.
	if (!locals.user) {
		redirect(303, '/login');
	}

	// Degrade gracefully (PLAN §12): a transient list failure renders an empty
	// list, not a 500. A brand-new user legitimately has zero groups, so an empty
	// list is also a normal state (the page shows a friendly empty state for it).
	let groups: Group[];
	try {
		groups = await listGroupsForUser(locals.user.id);
	} catch {
		groups = [];
	}

	return { groups };
};
