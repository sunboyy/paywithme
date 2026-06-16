// `/invite/[token]` accept flow (task 3.7; PLAN §6.2 — member-agnostic links).
//
// The route half of the invite system: a sharable link's landing page. The
// service core lives in `$lib/server/invites` (`getInvitePreview` /
// `getInviteAcceptInfo` / `acceptInvite`) — this file is the thin SvelteKit
// boundary.
//
// KEY DECISIONS (PLAN §6.2):
//   - Accepting ALWAYS requires a registered, logged-in user. An anonymous
//     visitor sees the invite CONTEXT (group name) + sign-in / create-account
//     links carrying `?redirectTo=/invite/<token>` so they return here after
//     auth (threaded by the Phase-2 pages, sanitized via `safeRedirectTo`).
//   - We do NOT auto-accept on GET. Accept is an explicit POST so that link
//     prefetchers, crawlers, and chat-app URL unfurlers can't silently join.
//     `load` only PREVIEWS / lists choices; the `accept` action mutates.
//   - The ANONYMOUS preview only ever exposes the GROUP NAME (PLAN §12). The
//     LOGGED-IN view additionally lists the group's CLAIMABLE member slots so the
//     invitee can choose link-existing vs join-new (member-agnostic accept).

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { acceptInviteSchema } from '$lib/schemas/invite';
import { acceptInvite, getInviteAcceptInfo, getInvitePreview } from '$lib/server/invites';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	// Anonymous: show the invite context + the auth links. We only need the safe
	// (group-name-only) preview here — never the claimable member list.
	if (!locals.user) {
		const preview = await getInvitePreview(params.token);
		return {
			state: 'need_auth' as const,
			groupName: preview.status === 'valid' ? preview.groupName : null,
			valid: preview.status === 'valid',
			redirectTo: '/invite/' + params.token
		};
	}

	// Logged in: resolve the accept-time info (group name + claimable slots). A
	// dead link (not-found / revoked / expired / dead group) → clear error.
	const info = await getInviteAcceptInfo(params.token);
	if (info.status === 'invalid') {
		return { state: 'invalid' as const };
	}

	// Logged in + valid: render the choice form. We do NOT accept here. The user's
	// display name is shown on the "join as a new member" option.
	return {
		state: 'ready' as const,
		groupName: info.groupName,
		userName: locals.user.name,
		claimableMembers: info.claimableMembers,
		acceptForm: await superValidate(zod4(acceptInviteSchema))
	};
};

export const actions: Actions = {
	accept: async ({ request, params, locals }) => {
		// Login gate (PLAN §6.2): an anonymous POST is bounced to `/login` with a
		// `redirectTo` back here so the accept continues after auth. `redirect()`
		// THROWS, so it sits outside any try/catch.
		if (!locals.user) {
			redirect(303, '/login?redirectTo=' + encodeURIComponent('/invite/' + params.token));
		}

		const form = await superValidate(request, zod4(acceptInviteSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		// Build the typed selection from the validated choice.
		const selection =
			form.data.mode === 'existing'
				? ({ mode: 'existing', memberId: form.data.memberId! } as const)
				: ({ mode: 'new' } as const);

		const result = await acceptInvite({
			userId: locals.user.id,
			userName: locals.user.name,
			token: params.token,
			selection
		});

		switch (result.status) {
			case 'accepted':
			case 'already_member':
				// Either way the user now has access — land them on the members page.
				redirect(303, '/groups/' + result.groupId + '/members');
				break;
			case 'slot_taken':
				// The chosen slot was just claimed — let them pick another or join new.
				return message(
					form,
					{
						type: 'error',
						text: 'That member was just claimed — pick another or join as a new member.'
					},
					{ status: 409 }
				);
			case 'invalid':
			default:
				return message(
					form,
					{ type: 'error', text: 'This invite is invalid, expired, or was revoked.' },
					{ status: 400 }
				);
		}
	}
};
