// `/groups/[id]/settings` — group settings: rename (PLAN §6.4).
//
// Server-first + progressively enhanced. `load` access-checks and seeds the
// rename form with the current name so the input pre-fills. The `rename` action
// validates → delegates to the group service → returns a superform message.
// 404 on no-access / soft-deleted group (§12).

import { error, fail } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { renameGroupSchema } from '$lib/schemas/group';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import { renameGroup, GroupAccessError } from '$lib/server/groups';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const { group } = await requireGroupAccess({ locals, groupId: params.id });

	return {
		group: { id: group.id, name: group.name },
		renameForm: await superValidate({ name: group.name }, zod4(renameGroupSchema), {
			errors: false
		})
	};
};

export const actions: Actions = {
	rename: async ({ request, params, locals }) => {
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(renameGroupSchema));
		if (!form.valid) {
			return fail(400, { renameForm: form });
		}

		try {
			await renameGroup({ userId: user.id, groupId: params.id, name: form.data.name });
		} catch (e) {
			if (e instanceof GroupAccessError) {
				error(404, 'Group not found');
			}
			return message(
				form,
				{ type: 'error', text: 'Could not rename the group. Please try again.' },
				{ status: 500 }
			);
		}

		return message(form, { type: 'success', text: 'Group renamed' });
	}
};
