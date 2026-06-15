import { describe, expect, it } from 'vitest';
import { authClient } from './auth-client';

// Light wiring test for the browser auth client (PLAN §5.1, §5.5), mirroring the
// spirit of `lib/server/auth.test.ts`: assert the client constructs and exposes
// the method surface the login / enrolment / logout flows depend on, without
// hitting the network. The two plugins' methods (`signIn.passkey` from
// `@better-auth/passkey/client`, `signIn.magicLink` from
// `better-auth/client/plugins`) confirm both plugins are registered.
//
// `createAuthClient` from `better-auth/svelte` constructs lazily and does not
// touch browser-only globals at import time under the node test env, so no
// mocking is needed here.
describe('authClient', () => {
	it('constructs and exposes signIn.passkey + signIn.magicLink (both plugins wired)', () => {
		expect(authClient).toBeDefined();
		expect(typeof authClient.signIn.passkey).toBe('function');
		expect(typeof authClient.signIn.magicLink).toBe('function');
	});

	it('exposes the shared session + sign-out surface used by later auth tasks', () => {
		// `signOut` (task 2.10) and `useSession` are part of the base client API.
		expect(typeof authClient.signOut).toBe('function');
		expect(typeof authClient.useSession).toBe('function');
	});
});
