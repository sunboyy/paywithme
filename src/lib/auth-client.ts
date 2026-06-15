// better-auth browser client (PLAN §5.1, §5.5).
//
// The single shared client that drives every client-side auth flow in the
// browser: passkey sign-in (§5.5), the magic-link `signIn.magicLink` call,
// passkey enrolment (`passkey.addPasskey`, task 2.9) and logout (`signOut`,
// task 2.10). It mirrors the server `lib/server/auth.ts` plugin set — magic
// link + passkey, passwordless only.
//
// This is a CLIENT module: it must stay free of server-only imports (no
// `$env/dynamic/private`, no `$lib/server/**`). The base URL is intentionally
// left to better-auth's default (the current page origin), which is correct for
// this same-origin app — the `/api/auth/[...all]` handler (task 2.2) is served
// from the same origin.

import { createAuthClient } from 'better-auth/svelte';
import { magicLinkClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

export const authClient = createAuthClient({
	plugins: [magicLinkClient(), passkeyClient()]
});
