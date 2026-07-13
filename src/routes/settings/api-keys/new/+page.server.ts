// `/settings/api-keys/new` — create an API key (PLAN §16.8).
//
// A DEDICATED ROUTE, not a dialog, and server-first by design: the `default`
// action mints the key and REDIRECTS to the reveal screen, so the whole flow —
// name, scope radio-cards, expiry presets/custom — works with JS disabled. Client
// enhancement (`superForm`) only adds inline validation messages on top.
//
// The minted plaintext is handed to the reveal screen through a one-time httpOnly
// flash cookie (see `lib/server/api-key-reveal.ts` for why that, and not a query
// param or a stash table). It is never logged, never persisted, and never returned
// in this action's own response body.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { createApiKeySchema } from '$lib/schemas/api-key';
import { createApiKeyForUser } from '$lib/server/api-keys';
import { setApiKeyReveal } from '$lib/server/api-key-reveal';
import type { Actions, PageServerLoad } from './$types';

/** Where the post-create redirect lands — the one-time reveal screen. */
const REVEAL_ROUTE = '/settings/api-keys/created';

export const load: PageServerLoad = async ({ locals }) => {
	// Minting a key acts on the caller's own account, so a session is required.
	// `redirect()` throws — keep it out of any try/catch (the 2.5/2.6 trap).
	if (!locals.user) {
		redirect(303, '/login');
	}

	// The schema's defaults (`scope: 'read'`, `expiry: 'never'`) seed the form, so
	// the SSR'd HTML already has the least-privilege, non-expiring options checked
	// — the no-JS user gets the right defaults without any client code.
	return { form: await superValidate(zod4(createApiKeySchema)) };
};

export const actions: Actions = {
	default: async ({ request, locals, cookies }) => {
		if (!locals.user) {
			redirect(303, '/login');
		}
		const userId = locals.user.id;

		const form = await superValidate(request, zod4(createApiKeySchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		let created;
		try {
			created = await createApiKeyForUser({ userId, input: form.data });
		} catch {
			// Generic message only — never leak the plugin's raw cause (PLAN §12).
			return message(
				form,
				{ type: 'error', text: 'Could not create that key. Please try again.' },
				{ status: 500 }
			);
		}

		// Stash the ONE-TIME plaintext for the reveal screen, then redirect. The
		// redirect (rather than rendering here) is what keeps the secret out of a
		// re-POSTable page and gives the no-JS path a clean GET to land on.
		setApiKeyReveal(cookies, {
			id: created.id,
			name: created.name,
			scope: created.scope,
			start: created.start,
			expiresAt: created.expiresAt,
			key: created.key
		});

		redirect(303, REVEAL_ROUTE);
	}
};
