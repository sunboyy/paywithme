// Server hooks (PLAN §5.7).
//
// Resolve the current better-auth session ONCE per request and attach it to
// `event.locals` so downstream `load` functions and form `actions` can read it
// without re-querying. Sessions/cookies are better-auth-managed (HTTP-only,
// Secure, SameSite=Lax — PLAN §5.7); we only read the session here.
//
// This hook RESOLVES and ATTACHES — it never blocks. Route protection
// (redirects/guards) belongs to individual routes / later tasks, not here.
//
// We use the plain `auth.api.getSession({ headers })` server API rather than
// better-auth's `svelteKitHandler` integration helper: that helper is for
// *mounting* the auth request handler inside the hook, but task 2.2 already
// mounts it via the `/api/auth/[...all]` catch-all route. For pure session
// resolution `getSession` is the minimal, idiomatic path.
//
// Composition seam: if more `handle` functions are needed later, wrap them with
// SvelteKit's `sequence()` and export the composed result here.

import { auth } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	try {
		// `getSession` returns `{ session, user }` for an authenticated request and
		// `null` for an anonymous one (no/expired cookie) — the normal logged-out
		// path, NOT an error.
		const result = await auth.api.getSession({ headers: event.request.headers });
		event.locals.user = result?.user ?? null;
		event.locals.session = result?.session ?? null;
	} catch (error) {
		// Be robust: a transient failure resolving the session (e.g. a DB blip)
		// must not 500 the entire app. Treat the request as anonymous and continue;
		// downstream guards will redirect protected routes as usual.
		console.error('[hooks.server] failed to resolve session', error);
		event.locals.user = null;
		event.locals.session = null;
	}

	return resolve(event);
};
