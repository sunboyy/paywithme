import { expect, test } from '@playwright/test';
import { addVirtualAuthenticator, getCredentials } from './support/webauthn';
import { deleteUserByEmail, getLatestMagicLinkUrlFor } from './support/db';

/**
 * Phase 2 auth end-to-end (task 2.12, PLAN §5 / §13).
 *
 * Covers the three flows the task pins down:
 *   1. Magic-link registration → first login → display name persisted.
 *   2. Passkey enrolment (CDP virtual authenticator) → logout → passkey login.
 *   3. Recovery via magic link (the email path works when passkeys aren't used).
 *
 * Magic-link interception is via the DB (`e2e/support/db.ts`): email is
 * console-only in dev, but the raw token lives in the `verification` table, so we
 * read it and drive the browser to the verify URL — no production-code change.
 *
 * Rate-limit budget (task 2.11): magic-link SEND is capped at 5/60s per IP and
 * all e2e requests share one IP. This file makes exactly TWO sends (register +
 * recovery login) and uses the passkey path for the returning-user login in
 * between, staying well under the cap. A unique email per run keeps the latest
 * `verification` row unambiguous and lets reruns coexist.
 *
 * Chromium-only: the virtual authenticator needs the CDP `WebAuthn` domain.
 */

// A unique address per run: avoids cross-run collisions and makes "the latest
// verification row for this email" unambiguous.
const TEST_EMAIL = `e2e-auth-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
const TEST_NAME = 'E2E Tester';

test.describe('auth e2e — magic link + passkey + recovery', () => {
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'Virtual authenticator needs Chromium.'
	);

	// Run the three flows as one ordered scenario in a single page/context so the
	// virtual authenticator's discoverable credential survives the logout→login
	// step (a fresh context would drop it). Splitting into independent tests would
	// either re-register (extra magic-link sends → rate cap) or need a shared
	// authenticator across contexts, which CDP does not provide.
	test.describe.configure({ mode: 'serial' });

	test.afterAll(async () => {
		// Clean up this run's user + verification rows so the DB doesn't accrete
		// test accounts. Self-contained: depends only on the unique email.
		await deleteUserByEmail(TEST_EMAIL);
	});

	test('register via magic link, enrol+use a passkey, then recover via magic link', async ({
		page,
		baseURL
	}) => {
		// baseURL is configured (http://localhost:4173); assert so TS narrows it and
		// a misconfig fails loudly rather than building "undefined/..." URLs.
		expect(baseURL, 'playwright baseURL must be set').toBeTruthy();
		const appBaseURL = baseURL as string;

		// ── Flow 1: magic-link registration → first login → name persisted ──────

		await page.goto('/register');
		await page.getByLabel('Email').fill(TEST_EMAIL);
		await page.getByLabel('Display name').fill(TEST_NAME);
		await page.getByRole('button', { name: 'Send sign-in link' }).click();

		// "Check your email" success UI (same copy whether or not the account
		// existed — PLAN §12), and the address is echoed back.
		await expect(page.getByText('Check your email for a sign-in link')).toBeVisible();
		await expect(page.getByText(TEST_EMAIL)).toBeVisible();

		// Intercept the emailed link from the DB and follow it. better-auth verifies
		// the token, sets the session cookie, and redirects to the callbackURL.
		const verifyUrl = await getLatestMagicLinkUrlFor(TEST_EMAIL, { baseURL: appBaseURL });
		await page.goto(verifyUrl);

		// New user with a name (passed on /register, persisted by better-auth on
		// create) and no passkey lands on the onboarding nudge (task 2.6 → 2.8). The
		// nudge's enrol button is the robust marker (the card title is a styled div,
		// not an ARIA heading).
		await expect(page).toHaveURL(/\/onboarding\/passkey$/);
		await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeVisible();

		// Auth-aware chrome (task 2.10) now shows the signed-in user (name preferred
		// over email; PLAN #26 name capture happened on create).
		await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
		await expect(page.getByText(TEST_NAME)).toBeVisible();

		// ── Flow 2: passkey enrolment (virtual authenticator) → passkey login ───

		// Attach the virtual authenticator BEFORE triggering enrolment so the
		// WebAuthn create ceremony has a platform authenticator to talk to. Keep the
		// id to assert a credential actually got created.
		const authenticatorId = await addVirtualAuthenticator(page);

		// Enrol from the onboarding nudge. On success it routes to `/`.
		await page.getByRole('button', { name: 'Add a passkey' }).click();
		await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(appBaseURL)}/?$`));

		// The virtual authenticator now holds exactly one discoverable credential.
		const credsAfterEnrol = await getCredentials(page, authenticatorId);
		expect(credsAfterEnrol.length).toBe(1);
		expect(credsAfterEnrol[0].isResidentCredential).toBe(true);

		// User-visible proof: the passkey appears in the `/settings` list.
		await page.goto('/settings');
		await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
		const passkeyList = page.getByRole('list', { name: 'Your passkeys' });
		await expect(passkeyList).toBeVisible();
		await expect(passkeyList.getByRole('listitem')).toHaveCount(1);

		// Log out via the header logout form (task 2.10).
		await page.getByRole('button', { name: 'Log out' }).click();
		await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

		// Sign back in with the PASSKEY primary button on /login. The virtual
		// authenticator's discoverable credential is auto-approved (UV + presence),
		// so no OS prompt is needed. Same context ⇒ the credential persists.
		await page.goto('/login');
		await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

		// The client lands on `/` after a successful assertion. Force a fresh
		// full-page load so the auth-aware chrome reflects the server-resolved
		// session (rather than any cached SPA `load` data from before sign-in).
		await page.waitForURL(new RegExp(`^${escapeRegExp(appBaseURL)}/?$`));
		await page.reload();

		// Back in the app and authenticated via the passkey: the logout control
		// returns and the header shows the signed-in user.
		await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
		await expect(page.getByText(TEST_NAME)).toBeVisible();

		// ── Flow 3: recovery via magic link (PLAN §5.6) ─────────────────────────
		// Demonstrate the email path always gets the user back in, even with a
		// passkey enrolled. This is the 2nd (and final) magic-link send — under cap.

		await page.getByRole('button', { name: 'Log out' }).click();
		await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

		await page.goto('/login');
		// Email fallback form on /login.
		await page.getByLabel('Email').fill(TEST_EMAIL);
		await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
		await expect(page.getByText('Check your email for a sign-in link')).toBeVisible();

		// Intercept the new link and follow it. An existing user with a name set is
		// routed to onboarding (the nudge self-gates, but a returning user with a
		// passkey still lands here per task 2.6's unconditional redirect).
		const recoveryUrl = await getLatestMagicLinkUrlFor(TEST_EMAIL, { baseURL: appBaseURL });
		await page.goto(recoveryUrl);

		// Authenticated again via the email path.
		await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
		await expect(page.getByText(TEST_NAME)).toBeVisible();
	});
});

/** Escape a string for safe interpolation into a RegExp (baseURL → anchored match). */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
