import type { Page } from '@playwright/test';

/**
 * WebAuthn virtual-authenticator groundwork (PLAN §13 — passkey enrol/login e2e).
 *
 * This is the foundation for the passkey end-to-end tests in task 2.12: it wires
 * a Chromium-only CDP (Chrome DevTools Protocol) virtual authenticator so passkey
 * registration and assertion can run headlessly without real hardware / OS prompts.
 *
 * Only Chromium exposes the CDP `WebAuthn` domain, which is why the Playwright
 * config pins a `chromium` project.
 */

export interface VirtualAuthenticatorOptions {
	/** CTAP protocol — passkeys use ctap2. */
	protocol?: 'ctap2' | 'u2f';
	/** Platform (internal) authenticator emulates an on-device passkey. */
	transport?: 'usb' | 'nfc' | 'ble' | 'cable' | 'internal';
	/** Resident keys (a.k.a. discoverable credentials) are required for passkeys. */
	hasResidentKey?: boolean;
	hasUserVerification?: boolean;
	/** Report the user as already verified so UV ceremonies succeed automatically. */
	isUserVerified?: boolean;
	/** Auto-approve presence checks so no manual touch is needed in CI. */
	automaticPresenceSimulation?: boolean;
}

const DEFAULT_OPTIONS: Required<VirtualAuthenticatorOptions> = {
	protocol: 'ctap2',
	transport: 'internal',
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	automaticPresenceSimulation: true
};

/**
 * Enable a WebAuthn virtual authenticator on the given page via CDP and return
 * its `authenticatorId` (used later to inspect/remove credentials).
 *
 * Usage (task 2.12):
 * ```ts
 * const authenticatorId = await addVirtualAuthenticator(page);
 * // …drive the passkey enrol / login UI…
 * ```
 */
export async function addVirtualAuthenticator(
	page: Page,
	options: VirtualAuthenticatorOptions = {}
): Promise<string> {
	const config = { ...DEFAULT_OPTIONS, ...options };

	// A CDP session is only available against Chromium-based browsers.
	const client = await page.context().newCDPSession(page);

	await client.send('WebAuthn.enable');
	const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
		options: config
	});

	return authenticatorId;
}

/**
 * Inspect the discoverable credentials currently stored on a virtual
 * authenticator. Used by task 2.12 to assert a passkey was actually created by
 * an enrolment ceremony (in addition to the user-visible `/settings` list).
 *
 * Opens its own short-lived CDP session, so it can run after `addVirtualAuthenticator`
 * without threading the original client through the test.
 */
export async function getCredentials(
	page: Page,
	authenticatorId: string
): Promise<Array<{ credentialId: string; isResidentCredential: boolean }>> {
	const client = await page.context().newCDPSession(page);
	const { credentials } = await client.send('WebAuthn.getCredentials', { authenticatorId });
	return credentials.map((c) => ({
		credentialId: c.credentialId,
		isResidentCredential: c.isResidentCredential
	}));
}
