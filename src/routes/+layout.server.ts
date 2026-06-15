// Root layout server load (PLAN §5.7, §10).
//
// Exposes just enough of the resolved session to the root layout so the app
// chrome can be auth-aware (a user indicator + logout button — task 2.10). The
// session itself is resolved once per request in `hooks.server.ts` and attached
// to `event.locals`; here we project ONLY the chrome-relevant fields (`name`,
// `email`) rather than returning the whole user object, to avoid over-exposing
// account data to the client bundle.

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
	user: locals.user ? { name: locals.user.name, email: locals.user.email } : null
});
