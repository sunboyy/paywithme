// `/register` server logic (PLAN §5.1–§5.3, §10, §12).
//
// Server-first + progressively enhanced: `load` seeds a superforms form and the
// default `action` validates the POST and triggers a better-auth magic link.
// Works with JS disabled (the <form> posts to this action); superforms `enhance`
// upgrades it when JS is present.
//
// Privacy (PLAN §12): we MUST NOT reveal whether an address already exists. The
// magic-link plugin is create-or-load (PLAN §5.3), and we return the same
// "sent" success regardless of outcome and never surface the raw error.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { registerSchema } from '$lib/schemas/auth';
import { auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// A logged-in user has no reason to register. Redirect to an EXISTING route
	// (`/groups` does not exist yet — task 3.4).
	if (locals.user) {
		redirect(303, '/');
	}

	return { form: await superValidate(zod4(registerSchema)) };
};

export const actions: Actions = {
	default: async ({ request }) => {
		// `request.formData()` is consumed by superValidate; clone the headers we
		// need to forward to better-auth BEFORE that (Request body is single-use).
		const headers = new Headers(request.headers);

		const form = await superValidate(request, zod4(registerSchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		const { email, name } = form.data;

		try {
			// Magic-link send. Verified against
			// node_modules/better-auth/dist/plugins/magic-link/index.d.mts:
			// the plugin exposes `auth.api.signInMagicLink` for POST /sign-in/magic-link,
			// body `{ email, name?, callbackURL? }`. Treated as create-or-load + email
			// link (PLAN §5.3). `callbackURL` points at the task-2.6 landing route.
			await auth.api.signInMagicLink({
				body: { email, name, callbackURL: '/auth/magic-link' },
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

		// Same success UX regardless of whether the user already existed (PLAN §12).
		return message(form, { type: 'sent', text: email });
	}
};
