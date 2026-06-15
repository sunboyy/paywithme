// `/onboarding/passkey` — post-first-login passkey nudge (PLAN §5.3 step 4, §5.4).
//
// Enrolment itself is client-side WebAuthn (`authClient.passkey.addPasskey()`),
// so there is no server action here — `load` just decides whether to render the
// nudge. The page is intentionally SELF-GATING: the task-2.6 magic-link landing
// sends EVERY authenticated, named user here unconditionally, and this `load`
// bounces anyone who already has a passkey straight to `/`. That keeps the
// landing logic simple and makes the onboarding step idempotent.

import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, request }) => {
	// Must be authenticated to enrol a passkey — `addPasskey` runs in the user's
	// own session (PLAN §5.4). An anonymous hit goes to login.
	if (!locals.user) {
		redirect(303, '/login');
	}

	// Self-gate: a user who already has ≥1 passkey has nothing to be nudged
	// about, so send them onward. We wrap ONLY the `listPasskeys` call in the
	// try/catch — `redirect()` throws in SvelteKit, so the redirects live OUTSIDE
	// the trap or the catch would swallow the navigation (same trap as 2.5/2.6).
	let passkeys: unknown[] | undefined;
	try {
		// Verified against node_modules/better-auth passkey plugin: `listPasskeys`
		// backs GET /passkey/list and returns the authenticated user's passkeys.
		passkeys = await auth.api.listPasskeys({ headers: request.headers });
	} catch {
		// Degrade gracefully (PLAN §12): a transient list failure must not 500 the
		// onboarding step. Fall through and render the nudge — worst case the user
		// re-enrols, and `addPasskey` is the client's own idempotent concern.
		return {};
	}

	if (passkeys && passkeys.length > 0) {
		redirect(303, '/');
	}

	// Authenticated with no passkey yet: render the nudge.
	return {};
};
