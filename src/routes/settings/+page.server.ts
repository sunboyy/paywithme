// `/settings` server logic — manage passkeys across devices (PLAN §5.4–§5.6).
//
// Server-first + progressively enhanced: `load` lists the authenticated user's
// passkeys; the `?/delete` action removes one. Both work with JS disabled (the
// delete <form> posts to this action). Enrolment (`addPasskey`) is client-side
// WebAuthn and therefore lives in the page, not here (PLAN §5.4).
//
// Rename is intentionally NOT implemented: better-auth assigns a sensible label
// at enrolment and the page resolves a device hint from the AAGUID, so a manual
// rename adds UI weight without a v1 need. The list/add/delete trio fully
// satisfies task 2.9's required scope; rename was explicitly optional.

import { fail, redirect } from '@sveltejs/kit';
import { message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { getAuthenticatorName } from '@better-auth/passkey';
import { deletePasskeySchema } from '$lib/schemas/auth';
import { revokeApiKeySchema } from '$lib/schemas/api-key';
import { auth } from '$lib/server/auth';
import {
	ApiKeyNotFoundError,
	listApiKeysForUser,
	revokeApiKeyForUser,
	type ApiKeyListItem
} from '$lib/server/api-keys';
import type { Actions, PageServerLoad } from './$types';

/** The trimmed passkey shape the page renders — never the raw credential. */
export type PasskeyListItem = {
	id: string;
	/** Better-auth's stored label, when present (may be undefined). */
	name: string | null;
	/** Best-effort authenticator/provider hint resolved from the AAGUID. */
	deviceHint: string | null;
	/** ISO string so it serializes cleanly to the client. */
	createdAt: string;
};

export const load: PageServerLoad = async ({ locals, request }) => {
	// Managing passkeys requires an authenticated session — `listPasskeys` and
	// `deletePasskey` act on the caller's own credentials (PLAN §5.4). An
	// anonymous hit goes to login. `redirect()` throws, so it lives OUTSIDE the
	// try/catch below or the catch would swallow the navigation (2.5/2.6 trap).
	if (!locals.user) {
		redirect(303, '/login');
	}

	// Degrade gracefully (PLAN §12): a transient list failure must render an empty
	// list, not a 500. A user who skipped onboarding legitimately has zero, so an
	// empty list is also a normal state, not an error.
	let passkeys: PasskeyListItem[];
	try {
		// Verified against the @better-auth/passkey plugin: `listPasskeys` backs
		// GET /passkey/list-user-passkeys and returns the caller's `Passkey[]`.
		const rows = await auth.api.listPasskeys({ headers: request.headers });
		passkeys = rows.map((pk) => ({
			id: pk.id,
			name: pk.name ?? null,
			deviceHint: getAuthenticatorName(pk.aaguid) ?? null,
			createdAt: new Date(pk.createdAt).toISOString()
		}));
	} catch {
		// Swallow and fall through with an empty list — never 500 the page.
		passkeys = [];
	}

	// API keys (PLAN §16.8) — the sibling section to passkeys. Same degrade-
	// gracefully rule: a transient list failure renders the empty state (which
	// offers Create + API docs), never a 500. Zero keys is the normal first-run
	// state anyway, so the two are visually identical and nothing is lost.
	let apiKeys: ApiKeyListItem[];
	try {
		apiKeys = await listApiKeysForUser({ headers: request.headers });
	} catch {
		apiKeys = [];
	}

	return {
		passkeys,
		apiKeys,
		// One delete form instance seeds the per-row hidden-id forms on the page.
		deleteForm: await superValidate(zod4(deletePasskeySchema)),
		// Likewise: one revoke form seeds the per-key hidden-id revoke forms.
		revokeApiKeyForm: await superValidate(zod4(revokeApiKeySchema))
	};
};

export const actions: Actions = {
	delete: async ({ request }) => {
		// `request.formData()` is consumed by superValidate; clone the headers we
		// forward to better-auth BEFORE that (the Request body is single-use).
		const headers = new Headers(request.headers);

		const form = await superValidate(request, zod4(deletePasskeySchema));
		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			// Verified against the plugin: `deletePasskey` backs
			// POST /passkey/delete-passkey, body `{ id }`, scoped to the caller's
			// own passkeys. Deleting the LAST passkey is intentionally allowed —
			// recovery is the email magic link (PLAN §5.6) — so we do not block it.
			await auth.api.deletePasskey({ body: { id: form.data.id }, headers });
		} catch {
			// Generic error only — never leak the raw cause (PLAN §12).
			return message(
				form,
				{ type: 'error', text: 'Could not remove that passkey. Please try again.' },
				{ status: 500 }
			);
		}

		// `load` re-runs after the action and re-lists, so the row disappears.
		return message(form, { type: 'success', text: 'Passkey removed' });
	},

	// Revoke an API key (PLAN §16.8) — the passkey-delete pattern, key for key:
	// a real per-row `<form>` (works with JS disabled) confirmed by
	// `ConfirmSubmit.svelte`. Revoke = delete, so the key 401s on its very next
	// request (§16.2); it is audited by the service.
	revokeApiKey: async ({ request, locals }) => {
		if (!locals.user) {
			redirect(303, '/login');
		}
		const userId = locals.user.id;

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
