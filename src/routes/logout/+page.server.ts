// `/logout` server logic (PLAN §5.7).
//
// Server-first + progressive enhancement: logout is a real form POST that works
// with JS disabled. The `default` action invalidates the better-auth session
// server-side via `auth.api.signOut`, and the cleared session cookie reaches the
// browser through the `sveltekitCookies` plugin wired LAST in `lib/server/auth`
// (it routes `auth.api.*` Set-Cookie through SvelteKit's cookie API). After
// clearing we redirect to `/login`.
//
// Error handling (the 2.5/2.6 trap): `redirect()` works by THROWING, so it must
// live OUTSIDE any catch that would swallow it. We only try/catch the `signOut`
// call; whether it succeeds or fails, the user's intent is "get me out", so we
// always fall through to the same redirect. A `signOut` failure is logged
// server-side but never leaked to the user.

import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	// Logout is POST-only; a bare GET to `/logout` should never error or render a
	// page. Bounce to the app root.
	redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request }) => {
		try {
			// Invalidate the session server-side. The `sveltekitCookies` plugin clears
			// the session cookie on the SvelteKit response automatically.
			await auth.api.signOut({ headers: request.headers });
		} catch (error) {
			// Robustness: a failed sign-out (e.g. a DB blip) must still end the user
			// in a logged-out place. Log it, never leak the cause, and fall through.
			console.error('[logout] signOut failed', error);
		}

		// MUST be outside the catch above — `redirect` throws, and a redirect is the
		// intended outcome on both the success and failure paths.
		redirect(303, '/login');
	}
};
