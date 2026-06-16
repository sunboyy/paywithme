// Root `/` server logic (PLAN §10: "redirect to dashboard if logged in").
//
// An authenticated visitor has no use for the anonymous landing page — send them
// straight to their groups dashboard. Anonymous visitors fall through to the
// existing `+page.svelte` landing placeholder. `redirect()` THROWS, so it's the
// last statement on the authed branch.

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) {
		redirect(303, '/groups');
	}

	return {};
};
