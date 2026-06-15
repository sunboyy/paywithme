// `/auth/magic-link` landing route (PLAN §5.3, §5.7, #26, §12).
//
// This is the `callbackURL` (and new-user callback) that better-auth redirects
// the browser to AFTER it has already verified the magic-link token and set the
// session cookie. By the time we get here `hooks.server.ts` (task 2.4) has
// resolved `locals.user`/`locals.session` from that cookie.
//
// Two jobs:
//  1. Surface verification failures. On a bad/expired/consumed token (or signup
//     disabled) better-auth redirects here with `?error=<CODE>` instead of a
//     session. We map known codes to friendly, non-leaky copy (PLAN §12) and
//     render a retry path — never echo the raw code.
//  2. Capture the display name (PLAN §5.3, #26). The magic-link plugin only
//     persists `name` when it CREATES the user, so an existing user who never
//     completed this step (or whose create-time name was blank) arrives with an
//     empty `user.name`. We then render a one-field form and write the name via
//     `auth.api.updateUser` in the user's own session.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { displayNameSchema } from '$lib/schemas/auth';
import { auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/**
 * Map a better-auth magic-link error code to friendly, non-leaky copy
 * (PLAN §12). Verified against
 * node_modules/better-auth/dist/plugins/magic-link/index.mjs: on failure the
 * plugin redirects to the callback with `?error=<CODE>`; known codes include
 * `INVALID_TOKEN`, `failed_to_create_user`, `failed_to_create_session`, and
 * `new_user_signup_disabled`. We never surface the raw code — only a generic,
 * actionable message — and default unknown codes to the same safe fallback.
 */
function friendlyAuthError(code: string): string {
	switch (code) {
		case 'new_user_signup_disabled':
			return 'New sign-ups are currently disabled. Please contact support if you think this is a mistake.';
		case 'INVALID_TOKEN':
		case 'failed_to_create_user':
		case 'failed_to_create_session':
		default:
			// Expired / already-used / otherwise-invalid link. Single-use,
			// short-lived links (PLAN §12) make this the common case.
			return 'This sign-in link is invalid or has expired. Please request a new one.';
	}
}

export const load: PageServerLoad = async ({ url, locals }) => {
	// (1) better-auth bounced us here with a verification failure.
	const errorCode = url.searchParams.get('error');
	if (errorCode) {
		return { error: friendlyAuthError(errorCode) };
	}

	// (2) No error param, but also no session: the page was reached without a
	// valid verification (a direct hit, or an already-consumed link that set no
	// cookie). Treat it as the invalid-link state so the user gets a retry path.
	// We deliberately do NOT redirect to `/login` — it doesn't exist until task
	// 2.7; `/register` is the resolvable retry route.
	if (!locals.user) {
		return { error: friendlyAuthError('INVALID_TOKEN') };
	}

	// (3) Authenticated. If the user already has a display name, onboarding is
	// complete — send them onward. Onward target is `/onboarding/passkey` (task
	// 2.8) → `/groups` (task 3.4); both are unbuilt, so route to `/` for now.
	if (locals.user.name?.trim()) {
		redirect(303, '/');
	}

	// Authenticated but no name yet (PLAN §5.3, #26): render the capture form.
	return { form: await superValidate(zod4(displayNameSchema)) };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		// Must be in a verified session to set a name — the magic-link flow sets
		// the cookie before redirecting here.
		if (!locals.user) {
			return fail(401, { message: 'Your session has expired. Please sign in again.' });
		}

		// `request.formData()` is consumed by superValidate; clone the headers we
		// forward to better-auth BEFORE that (the Request body is single-use).
		const headers = new Headers(request.headers);

		const form = await superValidate(request, zod4(displayNameSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			// Persist the display name in the user's own session (PLAN §5.3, #26).
			// `auth.api.updateUser` backs the better-auth `/update-user` endpoint;
			// forwarding the request headers runs it as the authenticated user.
			await auth.api.updateUser({ body: { name: form.data.name }, headers });
		} catch {
			// Genuine write failure (e.g. DB down). Return a generic error — never
			// the raw cause (PLAN §12). Note: this catch must NOT wrap the redirect
			// below; in SvelteKit `redirect()` throws, so catching around it would
			// swallow the navigation.
			return message(
				form,
				{ type: 'error', text: 'Could not save your name. Please try again.' },
				{ status: 500 }
			);
		}

		// Onward to the app (see the `load` forward-ref note above for the eventual
		// onboarding/groups target).
		redirect(303, '/');
	}
};
