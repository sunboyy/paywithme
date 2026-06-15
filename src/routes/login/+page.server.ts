// `/login` server logic (PLAN §5.1, §5.5, §5.3, §12).
//
// The email-magic-link FALLBACK for login. Passkey is the primary path (PLAN
// §5.5) and is client-only (WebAuthn), so it lives entirely in `+page.svelte`.
// This server action backs the email form, which is server-first and works with
// JS disabled: the <form> posts here and superforms `enhance` upgrades it when
// JS is present.
//
// No display name is collected here (unlike `/register`): an existing account
// already has one, and a brand-new address routed in via the create-or-load
// magic link captures its name on the `/auth/magic-link` landing (PLAN §5.3,
// #26).
//
// Privacy (PLAN §12): we MUST NOT reveal whether an address already exists. The
// magic-link plugin is create-or-load, so we return the same "sent" success
// regardless of outcome and never surface the raw error.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { loginSchema } from '$lib/schemas/auth';
import { auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// A logged-in user has no reason to sign in again. Redirect to an EXISTING
	// route (`/groups` does not exist yet — task 3.4).
	if (locals.user) {
		redirect(303, '/');
	}

	return { form: await superValidate(zod4(loginSchema)) };
};

export const actions: Actions = {
	default: async ({ request }) => {
		// `request.formData()` is consumed by superValidate; clone the headers we
		// need to forward to better-auth BEFORE that (Request body is single-use).
		const headers = new Headers(request.headers);

		const form = await superValidate(request, zod4(loginSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		const { email } = form.data;

		try {
			// Magic-link send (PLAN §5.5 fallback / §5.3). Same call as `/register`
			// but WITHOUT a `name` — login does not collect one. `callbackURL` points
			// at the task-2.6 landing route, which captures the name later if the
			// user's name is still empty.
			await auth.api.signInMagicLink({
				body: { email, callbackURL: '/auth/magic-link' },
				headers
			});
		} catch {
			// Genuine send failure (e.g. email transport down). Return a generic
			// error — never the raw cause, and never anything that leaks account
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
