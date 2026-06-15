// better-auth catch-all mount (PLAN §4, §5.1).
//
// A single SvelteKit catch-all server route mounts the better-auth request
// handler so the browser auth client reaches better-auth. This serves
// magic-link verification, passkey (WebAuthn) ceremonies, and session
// endpoints — every `/api/auth/*` path better-auth owns.
//
// `auth.handler` is a web-standard `(request: Request) => Promise<Response>`,
// so the route just forwards the incoming `Request`. better-auth uses GET and
// POST only; we deliberately do not blanket-export unused verbs.

import { auth } from '$lib/server/auth';
import type { RequestHandler } from './$types';

const handler: RequestHandler = ({ request }) => auth.handler(request);

export const GET = handler;
export const POST = handler;
