// `/settings/api-keys/created` — the ONE-TIME secret reveal (PLAN §16.8).
//
// The post-create redirect lands here. `takeApiKeyReveal` reads the flash cookie
// AND deletes it in the same response, so the plaintext is rendered exactly once:
// a refresh (or anyone opening this URL cold) finds nothing and is sent back to
// Settings. That is the "shown once — you won't see this again" warning made true
// in code, not just in copy.
//
// The masked form is computed SERVER-SIDE so the no-JS default state is the masked
// banner; the full secret sits behind a `<details>` toggle in the page (which also
// needs no JS).

import { redirect } from '@sveltejs/kit';
import { takeApiKeyReveal } from '$lib/server/api-key-reveal';
import { maskApiKeySecret } from '$lib/server/api-keys';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies }) => {
	// `redirect()` throws — keep both redirects out of any try/catch.
	if (!locals.user) {
		redirect(303, '/login');
	}

	const reveal = takeApiKeyReveal(cookies);
	if (!reveal) {
		// No key in flight: a refresh, a bookmark, or an expired flash. Nothing to
		// show — and by design nothing CAN be shown again.
		redirect(303, '/settings');
	}

	return {
		key: reveal.key,
		masked: maskApiKeySecret(reveal.key),
		name: reveal.name,
		scope: reveal.scope,
		expiresAt: reveal.expiresAt
	};
};
