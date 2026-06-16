// `/groups/[id]/members` server logic — manage members + soft-deactivate
// (task 3.5; PLAN §6.1, §6.2 display-name edit, §6.3 lifecycle).
//
// Server-first + progressively enhanced: `load` fetches the access-checked group
// and its members (incl. deactivated) and seeds the add/rename/remove/reactivate
// forms; the actions validate + delegate to the task-3.5 member service. Every
// action works with JS disabled (each posts to a real form action with a hidden
// `memberId`, like settings' delete form); superforms `enhance` upgrades them.
//
// SCOPE: invite links (create/copy/revoke) are task 3.6 and are NOT built here,
// even though PLAN §10 lists them on this route — 3.6 adds that section.
//
// ERROR MAPPING (consistent with the 3.3/3.5 error model): `GroupAccessError`
// (no access / soft-deleted group) and `MemberNotFoundError` (member not in this
// group) both map to `error(404)`; any other failure surfaces as a generic
// message (never leaking the raw cause — PLAN §12).

import { error, fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { addMemberSchema, memberIdSchema, renameMemberSchema } from '$lib/schemas/member';
import { getGroupForUser, GroupAccessError } from '$lib/server/groups';
import {
	addMember,
	listMembers,
	reactivateMember,
	removeMember,
	renameMember,
	MemberNotFoundError,
	type MemberListItem
} from '$lib/server/members';
import type { Actions, PageServerLoad } from './$types';

/** Maps the service error model to HTTP: not-found errors → 404, else rethrow. */
function isNotFoundError(e: unknown): boolean {
	return e instanceof GroupAccessError || e instanceof MemberNotFoundError;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	// Member management requires an authenticated session (access is via a linked
	// member — PLAN §6.1). `redirect()` THROWS, so it lives OUTSIDE the try/catch
	// below or the catch would swallow the navigation.
	if (!locals.user) {
		redirect(303, '/login');
	}

	// Access-checked group fetch (3.3 service). `null` = no access / soft-deleted
	// → not-found (PLAN §6.4 "routes return not-found"). We never leak existence.
	const group = await getGroupForUser(locals.user.id, params.id);
	if (!group) {
		error(404, 'Group not found');
	}

	// Degrade gracefully (PLAN §12): a transient list failure renders an empty
	// member list rather than 500-ing the whole page. (Access already succeeded,
	// so the group header still shows.)
	let members: MemberListItem[];
	try {
		members = await listMembers({ userId: locals.user.id, groupId: params.id });
	} catch (e) {
		// A real access/not-found here would be a race (the group vanished between
		// the two reads) — re-surface as 404. Anything else → empty list.
		if (isNotFoundError(e)) {
			error(404, 'Group not found');
		}
		members = [];
	}

	return {
		// The viewer's own user id so the page can mark their linked member "You".
		viewerUserId: locals.user.id,
		group: { id: group.id, name: group.name, settlementCurrency: group.settlementCurrency },
		members,
		// Seeded forms for the per-row + add controls (their ids fill in per row).
		addForm: await superValidate(zod4(addMemberSchema)),
		renameForm: await superValidate(zod4(renameMemberSchema)),
		removeForm: await superValidate(zod4(memberIdSchema)),
		reactivateForm: await superValidate(zod4(memberIdSchema))
	};
};

export const actions: Actions = {
	addMember: async ({ request, params, locals }) => {
		// Guard the mutation too — never trust that `load` ran. THROWS.
		if (!locals.user) {
			redirect(303, '/login');
		}

		const form = await superValidate(request, zod4(addMemberSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await addMember({
				userId: locals.user.id,
				groupId: params.id,
				displayName: form.data.displayName
			});
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Group not found');
			}
			return message(
				form,
				{ type: 'error', text: 'Could not add that member. Please try again.' },
				{ status: 500 }
			);
		}

		// `load` re-runs after the action, so the new member appears.
		return message(form, { type: 'success', text: 'Member added' });
	},

	renameMember: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirect(303, '/login');
		}

		const form = await superValidate(request, zod4(renameMemberSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await renameMember({
				userId: locals.user.id,
				groupId: params.id,
				memberId: form.data.memberId,
				displayName: form.data.displayName
			});
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Member not found');
			}
			return message(
				form,
				{ type: 'error', text: 'Could not rename that member. Please try again.' },
				{ status: 500 }
			);
		}

		return message(form, { type: 'success', text: 'Member renamed' });
	},

	removeMember: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirect(303, '/login');
		}

		const form = await superValidate(request, zod4(memberIdSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await removeMember({
				userId: locals.user.id,
				groupId: params.id,
				memberId: form.data.memberId
			});
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Member not found');
			}
			return message(
				form,
				{ type: 'error', text: 'Could not remove that member. Please try again.' },
				{ status: 500 }
			);
		}

		return message(form, { type: 'success', text: 'Member removed' });
	},

	reactivate: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirect(303, '/login');
		}

		const form = await superValidate(request, zod4(memberIdSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await reactivateMember({
				userId: locals.user.id,
				groupId: params.id,
				memberId: form.data.memberId
			});
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Member not found');
			}
			return message(
				form,
				{ type: 'error', text: 'Could not reactivate that member. Please try again.' },
				{ status: 500 }
			);
		}

		return message(form, { type: 'success', text: 'Member reactivated' });
	}
};
