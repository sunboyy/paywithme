// `/groups/[id]/members` server logic — manage members + soft-deactivate
// (task 3.5; PLAN §6.1, §6.2 display-name edit, §6.3 lifecycle).
//
// Server-first + progressively enhanced: `load` fetches the access-checked group
// and its members (incl. deactivated) and seeds the add/rename/remove/reactivate
// forms; the actions validate + delegate to the task-3.5 member service. Every
// action works with JS disabled (each posts to a real form action with a hidden
// `memberId`, like settings' delete form); superforms `enhance` upgrades them.
//
// SCOPE: task 3.6 ADDS the invite-links section to this route (PLAN §10 hosts
// create/copy/revoke here). The ACCEPT flow (`/invite/[token]`) is task 3.7 and
// is NOT built here.
//
// ERROR MAPPING (consistent with the 3.3/3.5 error model): `GroupAccessError`
// (no access / soft-deleted group), `MemberNotFoundError` (member not in group),
// and `InviteNotFoundError` (invite not in group) all map to `error(404)`; any
// other failure is a generic message (never leaking the raw cause — §12).

import { error, fail } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { addMemberSchema, memberIdSchema, renameMemberSchema } from '$lib/schemas/member';
import { createInviteSchema, revokeInviteSchema } from '$lib/schemas/invite';
import { GroupAccessError } from '$lib/server/groups';
import { requireGroupAccess, requireUser } from '$lib/server/access';
import {
	addMember,
	listMembers,
	reactivateMember,
	removeMember,
	renameMember,
	MemberNotFoundError,
	type MemberListItem
} from '$lib/server/members';
import {
	createInvite,
	listActiveInvites,
	revokeInvite,
	InviteNotFoundError,
	type ActiveInvite
} from '$lib/server/invites';
import type { Actions, PageServerLoad } from './$types';

/** Maps the service error model to HTTP: not-found errors → 404, else rethrow. */
function isNotFoundError(e: unknown): boolean {
	return (
		e instanceof GroupAccessError ||
		e instanceof MemberNotFoundError ||
		e instanceof InviteNotFoundError
	);
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	// Single centralized guard (task 3.8): anonymous → `redirect(303,'/login')`,
	// no-access / not-found / soft-deleted → `error(404)` (PLAN §12 single check,
	// existence never leaked). Both helpers THROW control flow, so this call lives
	// OUTSIDE the try/catch blocks below or the catch would swallow the navigation.
	// It also returns the already-loaded `group`, so we don't re-query.
	const { user, group } = await requireGroupAccess({ locals, groupId: params.id });

	// Degrade gracefully (PLAN §12): a transient list failure renders an empty
	// member list rather than 500-ing the whole page. (Access already succeeded,
	// so the group header still shows.)
	let members: MemberListItem[];
	try {
		members = await listMembers({ userId: user.id, groupId: params.id });
	} catch (e) {
		// A real access/not-found here would be a race (the group vanished between
		// the two reads) — re-surface as 404. Anything else → empty list.
		if (isNotFoundError(e)) {
			error(404, 'Group not found');
		}
		members = [];
	}

	// Active invite links (PLAN §6.2). Degrade gracefully: a transient invites
	// failure renders an empty list rather than 500-ing the whole members page.
	// (A real access/not-found here would be a race — re-surface as 404.)
	let invites: ActiveInvite[];
	try {
		invites = await listActiveInvites({ userId: user.id, groupId: params.id });
	} catch (e) {
		if (isNotFoundError(e)) {
			error(404, 'Group not found');
		}
		invites = [];
	}

	return {
		// The viewer's own user id so the page can mark their linked member "You".
		viewerUserId: user.id,
		group: { id: group.id, name: group.name, settlementCurrency: group.settlementCurrency },
		members,
		invites,
		// The request origin so the page can render the ABSOLUTE invite URL
		// `${origin}/invite/${token}` (selectable text + a Copy button).
		origin: url.origin,
		// Seeded forms for the per-row + add controls (their ids fill in per row).
		addForm: await superValidate(zod4(addMemberSchema)),
		renameForm: await superValidate(zod4(renameMemberSchema)),
		removeForm: await superValidate(zod4(memberIdSchema)),
		reactivateForm: await superValidate(zod4(memberIdSchema)),
		createInviteForm: await superValidate(zod4(createInviteSchema)),
		revokeInviteForm: await superValidate(zod4(revokeInviteSchema))
	};
};

export const actions: Actions = {
	addMember: async ({ request, params, locals }) => {
		// Guard the mutation too — never trust that `load` ran. `requireUser` THROWS
		// a redirect for an anonymous caller (task 3.8 centralized guard); the
		// service then re-asserts group access (→ 404) as defense in depth.
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(addMemberSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await addMember({
				userId: user.id,
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
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(renameMemberSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await renameMember({
				userId: user.id,
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
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(memberIdSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await removeMember({
				userId: user.id,
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
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(memberIdSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await reactivateMember({
				userId: user.id,
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
	},

	createInvite: async ({ request, params, locals }) => {
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(createInviteSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			// Member-agnostic link (PLAN §6.2): no target — the invitee chooses on accept.
			await createInvite({ userId: user.id, groupId: params.id });
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Group not found');
			}
			return message(
				form,
				{ type: 'error', text: 'Could not create an invite link. Please try again.' },
				{ status: 500 }
			);
		}

		// `load` re-runs after the action, so the new link appears in the list.
		return message(form, { type: 'success', text: 'Invite link created' });
	},

	revokeInvite: async ({ request, params, locals }) => {
		const user = requireUser(locals);

		const form = await superValidate(request, zod4(revokeInviteSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await revokeInvite({
				userId: user.id,
				groupId: params.id,
				inviteId: form.data.inviteId
			});
		} catch (e) {
			if (isNotFoundError(e)) {
				error(404, 'Invite not found');
			}
			return message(
				form,
				{ type: 'error', text: 'Could not revoke that invite. Please try again.' },
				{ status: 500 }
			);
		}

		return message(form, { type: 'success', text: 'Invite link revoked' });
	}
};
