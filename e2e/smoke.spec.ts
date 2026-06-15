import { expect, test } from '@playwright/test';
import { addVirtualAuthenticator } from './support/webauthn';

// Smoke tests that prove the e2e harness is wired correctly (task 1.12).
// Real product flows (magic-link, passkey enrol/login, group settle) come later.

test('landing page renders the app', async ({ page }) => {
	await page.goto('/');

	// The header link and the landing card both surface "Pay with me".
	await expect(page).toHaveTitle(/Pay with me/);
	await expect(page.getByRole('link', { name: 'Pay with me' })).toBeVisible();
	await expect(page.getByText('Split group spending and settle up, the easy way.')).toBeVisible();
});

// Proves the Chromium CDP WebAuthn wiring works end-to-end, so task 2.12 can
// build the full passkey enrol/login flow on top of this helper.
test('virtual authenticator can be added via CDP (chromium)', async ({ page, browserName }) => {
	test.skip(browserName !== 'chromium', 'Virtual authenticator requires Chromium CDP.');

	await page.goto('/');
	const authenticatorId = await addVirtualAuthenticator(page);
	expect(authenticatorId).toBeTruthy();
});
