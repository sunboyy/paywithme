// `/settings/api-keys` — list and revoke your API keys (PLAN §16.8).
//
// This is the section's own screen, so the URL hierarchy is complete: the list
// sits at the parent of `/new` and `/created` instead of those two hanging off a
// path that 404s. `/settings` keeps the account/sign-in surface.
//
// Server-first: the list comes from `load`, and revoke is a real per-row form
// action that works with JS disabled.

import { fail } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { revokeApiKeySchema } from '$lib/schemas/api-key';
import { requireUser } from '$lib/server/access';
import { pathAndQuery } from '$lib/redirect';
import {
	ApiKeyNotFoundError,
	listApiKeysForUser,
	revokeApiKeyForUser,
	type ApiKeyListItem
} from '$lib/server/api-keys';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, request, url }) => {
	// `redirect()` throws, so it stays OUTSIDE the try/catch below.
	requireUser(locals, { redirectTo: pathAndQuery(url) });

	// Degrade gracefully (PLAN §12): a transient list failure renders the empty
	// state (which offers Create + API docs), never a 500. Zero keys is the normal
	// first-run state anyway, so the two are visually identical and nothing is lost.
	let apiKeys: ApiKeyListItem[];
	try {
		apiKeys = await listApiKeysForUser({ headers: request.headers });
	} catch {
		apiKeys = [];
	}

	return {
		apiKeys,
		// One revoke form seeds the per-key hidden-id revoke forms.
		revokeApiKeyForm: await superValidate(zod4(revokeApiKeySchema))
	};
};

export const actions: Actions = {
	// Revoke an API key (PLAN §16.8) — the passkey-delete pattern, key for key:
	// a real per-row `<form>` (works with JS disabled) confirmed by
	// `ConfirmSubmit.svelte`. Revoke = delete, so the key 401s on its very next
	// request (§16.2); it is audited by the service.
	revokeApiKey: async ({ request, locals, url }) => {
		const userId = requireUser(locals, { redirectTo: url.pathname }).id;

		// Clone the headers BEFORE `superValidate` consumes the (single-use) body —
		// the plugin's session-scoped `getApiKey`/`deleteApiKey` need them.
		const headers = new Headers(request.headers);

		const form = await superValidate(request, zod4(revokeApiKeySchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await revokeApiKeyForUser({ userId, keyId: form.data.id, headers });
		} catch (e) {
			// Absent / not-ours are conflated by the service, so this message says
			// nothing about whether the id exists (no enumeration signal).
			const text =
				e instanceof ApiKeyNotFoundError
					? 'That API key no longer exists.'
					: 'Could not revoke that key. Please try again.';
			return message(form, { type: 'error', text }, { status: 500 });
		}

		// `load` re-runs after the action, so the revoked key disappears from the list.
		return message(form, { type: 'success', text: 'API key revoked' });
	}
};
