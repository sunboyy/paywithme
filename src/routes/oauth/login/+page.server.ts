// `/oauth/login` — sign-in for the Claude.ai (MCP OAuth connector) authorization
// flow (ADR-0010; sibling of `/oauth/consent`).
//
// better-auth's MCP OAuth authorize endpoint sends an UNAUTHENTICATED resource
// owner here (`mcp({ loginPage: '/oauth/login' })`) with the pending OAuth request
// in the query. This is a DEDICATED login surface so the everyday `/login` stays
// free of OAuth concerns: it authenticates the user and then RESUMES the
// authorization (see `$lib/oauth-resume`) with a full-page navigation to the
// authorize endpoint — so its 302 back to the OAuth client's callback is followed
// by the BROWSER (a client-side passkey fetch would swallow that redirect, which
// is exactly why the plugin's own resume can't complete a custom login page).
//
// The magic-link send MIRRORS `/login`'s action (same PLAN §12 privacy contract:
// identical body, generic errors, and the SAME "sent" UX regardless of whether the
// account exists). The only difference is the caller populates the hidden
// `redirectTo` with the OAuth resume URL, so the `/auth/magic-link` landing
// forwards there post-verify — which also completes the flow ACROSS DEVICES, where
// the plugin's resume cookie is absent.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/schemas/auth';
import { auth } from '$lib/server/auth';
import { oauthResumeUrl } from '$lib/oauth-resume';
import { safeRedirectTo } from '$lib/redirect';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// The authorize endpoint appended the pending OAuth request; rebuild the
	// same-origin resume URL. If this page is reached WITHOUT an OAuth request there
	// is nothing to connect — this is not a general-purpose login, so send the
	// visitor to the real one.
	const oauthResume = oauthResumeUrl(url.searchParams);
	if (!oauthResume) {
		redirect(303, '/login');
	}

	// Already authenticated → resume the authorization immediately, no re-login.
	if (locals.user) {
		redirect(303, oauthResume);
	}

	return { form: await superValidate(zod4(loginSchema)), oauthResume };
};

export const actions: Actions = {
	default: async ({ request }) => {
		// `request.formData()` is consumed by superValidate; clone the headers we
		// need to forward to better-auth BEFORE that (Request body is single-use).
		const headers = new Headers(request.headers);

		// The hidden `redirectTo` field carries the OAuth resume URL (a safe local
		// path). Sanitize BEFORE superValidate consumes the body.
		const formData = await request.clone().formData();
		const redirectTo = safeRedirectTo(formData.get('redirectTo'));

		const form = await superValidate(request, zod4(loginSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		const { email } = form.data;

		try {
			// Same call as `/login` (PLAN §5.5 / §5.3): email-only, no name. Threading
			// the resume URL through `callbackURL` makes the `/auth/magic-link` landing
			// forward to the authorize endpoint after verification.
			await auth.api.signInMagicLink({
				body: {
					email,
					callbackURL:
						'/auth/magic-link' + (redirectTo ? '?redirectTo=' + encodeURIComponent(redirectTo) : '')
				},
				headers
			});
		} catch {
			// Generic error — never the raw cause, never anything that leaks account
			// existence (PLAN §12).
			return message(
				form,
				{ type: 'error', text: 'Could not send the sign-in link. Please try again.' },
				{ status: 500 }
			);
		}

		// Same success UX regardless of whether the account existed (PLAN §12).
		return message(form, { type: 'sent', text: email });
	}
};
