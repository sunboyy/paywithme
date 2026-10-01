// `/oauth/login` — sign-in for the Claude.ai (MCP OAuth connector) authorization
// flow (ADR-0010; sibling of `/oauth/consent`).
//
// The OAuth authorize endpoint sends a resource owner here
// (`mcp({ loginPage: '/oauth/login' })`) with the pending OAuth request, signed,
// in the query — when they have no session, or when the client asked for a fresh
// login (`prompt=login` / `max_age`). This is a DEDICATED login surface so the
// everyday `/login` stays free of OAuth concerns: it authenticates the user, then
// `load` RESUMES the authorization (see `$lib/oauth-resume`) with a redirect to
// the authorize endpoint, whose 302 back to the OAuth client's callback the
// browser follows.
//
// The magic-link send MIRRORS `/login`'s action (same PLAN §12 privacy contract:
// identical body, generic errors, and the SAME "sent" UX regardless of whether the
// account exists). The only difference is the caller populates the hidden
// `redirectTo` with this page's own URL (`continueTo`), so the `/auth/magic-link`
// landing comes back here post-verify and `load` resumes — which also completes
// the flow ACROSS DEVICES.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/schemas/auth';
import { auth } from '$lib/server/auth';
import { verifiedRequestIssuedAt } from '$lib/server/oauth-request';
import { isOAuthContinuation, oauthResumeUrl } from '$lib/oauth-resume';
import { magicLinkCallbackURL } from '$lib/magic-link';
import { pathAndQuery, safeRedirectTo } from '$lib/redirect';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// If this page is reached WITHOUT an OAuth request there is nothing to connect —
	// this is not a general-purpose login, so send the visitor to the real one.
	if (!isOAuthContinuation(url.searchParams)) {
		redirect(303, '/login');
	}

	// Signed in, with a session that satisfies the request → resume the
	// authorization. This is the ONLY place the flow resumes: after a sign-in the
	// page reloads itself, so a session that doesn't satisfy `prompt=login` /
	// `max_age` (e.g. the old one, after a cancelled passkey prompt) just gets the
	// form again.
	if (locals.user && locals.session) {
		const resume = oauthResumeUrl(
			url.searchParams,
			new Date(locals.session.createdAt),
			// Trusted only if the provider's signature on the request checks out.
			await verifiedRequestIssuedAt(url.searchParams)
		);
		if (resume) redirect(303, resume);
	}

	// Where both sign-in paths come back to: this page, with the request intact.
	return { form: await superValidate(zod4(loginSchema)), continueTo: pathAndQuery(url) };
};

export const actions: Actions = {
	default: async ({ request }) => {
		// `request.formData()` is consumed by superValidate; clone the headers we
		// need to forward to better-auth BEFORE that (Request body is single-use).
		const headers = new Headers(request.headers);

		// The hidden `redirectTo` field carries this page's URL with the OAuth
		// request (a safe local path). Sanitize BEFORE superValidate consumes the body.
		const formData = await request.clone().formData();
		const redirectTo = safeRedirectTo(formData.get('redirectTo'));

		const form = await superValidate(request, zod4(loginSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		const { email } = form.data;

		try {
			// Same call as `/login` (PLAN §5.5 / §5.3): email-only, no name. Threading
			// `redirectTo` through `callbackURL` makes the `/auth/magic-link` landing
			// come back to this page after verification, where `load` resumes.
			await auth.api.signInMagicLink({
				body: {
					email,
					callbackURL: magicLinkCallbackURL(redirectTo)
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
