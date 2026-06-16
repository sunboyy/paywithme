// `/invite/[token]` accept flow (task 3.7; PLAN §6.2).
//
// The route half of the invite system: a sharable link's landing page. The
// service core lives in `$lib/server/invites` (`getInvitePreview` /
// `acceptInvite`) — this file is the thin SvelteKit boundary.
//
// KEY DECISIONS (PLAN §6.2):
//   - Accepting ALWAYS requires a registered, logged-in user. An anonymous
//     visitor sees the invite CONTEXT (group name) + sign-in / create-account
//     links carrying `?redirectTo=/invite/<token>` so they return here after
//     auth (threaded by the Phase-2 pages, sanitized via `safeRedirectTo`).
//   - We do NOT auto-accept on GET. Accept is an explicit POST so that link
//     prefetchers, crawlers, and chat-app URL unfurlers can't silently claim a
//     slot. `load` only PREVIEWS; the `accept` action mutates.
//   - The preview only ever exposes the GROUP NAME (the token-holder was
//     invited); never anything else (PLAN §12 don't-leak).

import { fail, redirect } from '@sveltejs/kit';
import { acceptInvite, getInvitePreview } from '$lib/server/invites';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const preview = await getInvitePreview(params.token);

	// Anonymous: show the invite context + the auth links. We pass BOTH the group
	// name (when valid) and a `valid` flag so the page can render the invalid
	// message instead of sign-in buttons for a dead link, plus the sanitized
	// `redirectTo` so login/register bring the invitee back here.
	if (!locals.user) {
		return {
			state: 'need_auth' as const,
			groupName: preview.status === 'valid' ? preview.groupName : null,
			valid: preview.status === 'valid',
			redirectTo: '/invite/' + params.token
		};
	}

	// Logged in but the link is dead (not-found / revoked / expired): clear error.
	if (preview.status === 'invalid') {
		return { state: 'invalid' as const };
	}

	// Logged in + valid: render the explicit Accept button. We do NOT accept here.
	return { state: 'ready' as const, groupName: preview.groupName };
};

export const actions: Actions = {
	accept: async ({ params, locals }) => {
		// Login gate (PLAN §6.2): an anonymous POST is bounced to `/login` with a
		// `redirectTo` back here so the accept continues after auth. `redirect()`
		// THROWS, so it sits outside any try/catch.
		if (!locals.user) {
			redirect(303, '/login?redirectTo=' + encodeURIComponent('/invite/' + params.token));
		}

		const result = await acceptInvite({
			userId: locals.user.id,
			userName: locals.user.name,
			token: params.token
		});

		switch (result.status) {
			case 'accepted':
			case 'already_member':
				// Either way the user now has access — land them on the members page.
				redirect(303, '/groups/' + result.groupId + '/members');
				break;
			case 'slot_taken':
				return fail(409, {
					state: 'slot_taken' as const,
					message: 'This invitation has already been used.'
				});
			case 'invalid':
			default:
				return fail(400, {
					state: 'invalid' as const,
					message: 'This invite is invalid, expired, or was revoked.'
				});
		}
	}
};
