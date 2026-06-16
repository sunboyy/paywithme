// `/groups/new` create-group server logic (PLAN §6, §10).
//
// Server-first + progressively enhanced: `load` seeds a superforms form and the
// default `action` validates the POST and creates the group via the task-3.3
// service (`createGroup`) — this route NEVER reimplements group logic. Works with
// JS disabled (the <form> posts to this action); superforms `enhance` upgrades it.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { createGroupSchema } from '$lib/schemas/group';
import { createGroup } from '$lib/server/groups';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Creating a group requires an authenticated session (the creator becomes the
	// first member — PLAN §6.1). `redirect()` THROWS, so it stays outside any
	// try/catch.
	if (!locals.user) {
		redirect(303, '/login');
	}

	return { form: await superValidate(zod4(createGroupSchema)) };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		// Guard the mutation too — never trust that `load` ran for this request.
		// THROWS, so it stays above the validate/try below.
		if (!locals.user) {
			redirect(303, '/login');
		}

		const form = await superValidate(request, zod4(createGroupSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			// Delegate to the 3.3 service. `CurrencyLockedError` is not reachable on
			// CREATE (a brand-new group has no transactions), so we only guard the
			// generic failure path here.
			await createGroup({
				userId: locals.user.id,
				userName: locals.user.name,
				name: form.data.name,
				settlementCurrency: form.data.settlementCurrency
			});
		} catch {
			// Generic error only — never leak the raw cause (PLAN §12).
			return message(
				form,
				{ type: 'error', text: 'Could not create the group. Please try again.' },
				{ status: 500 }
			);
		}

		// Redirect to the dashboard: the group overview (`/groups/[id]`) and members
		// (`/groups/[id]/members`) routes are task 3.5+ and don't exist yet, so
		// landing there would 404. Once those routes exist, this target can move to
		// the newly created group's overview. `redirect()` THROWS — keep it outside
		// the try/catch above.
		redirect(303, '/groups');
	}
};
