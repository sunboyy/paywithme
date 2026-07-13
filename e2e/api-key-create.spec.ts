import { expect, test } from '@playwright/test';
import {
	deleteApiKeysOwnedBy,
	deleteAuditRowsActedBy,
	deleteUserByEmail,
	getLatestMagicLinkUrlFor
} from './support/db';

/**
 * Create-key e2e (PLAN §16.8) — the expiry control, end to end in a real browser.
 *
 * This exists because the two bugs it pins are INVISIBLE below the browser:
 *
 *  1. **A preset expiry could not be submitted once the custom field had been
 *     touched.** Svelte's `bind:value` on a `type="number"` input writes `null`
 *     when the input is cleared, and `z.coerce.number()` coerces `null` (like
 *     `''`) to `0` — which failed the ≥1 bound. The client validator then pinned
 *     "Choose at least 1 day" on a field the user had abandoned, and never / 30 /
 *     90 / 365 all refused to submit until it was refilled. Only a real browser
 *     produces that `null`: a unit test hands the schema an object where the key
 *     is simply ABSENT, which always passed.
 *  2. **The custom-days field was always visible**, even for a preset — it read
 *     as required when it wasn't (and gave the user the field to touch).
 *
 * The reveal is CSS (`:has()` + `:checked`), not `{#if}`, so it still works with
 * JS disabled (§16.8). `toBeVisible()` is therefore a real assertion about the
 * cascade, and jsdom component tests can't make it — Vitest doesn't apply the
 * component's styles.
 *
 * Chromium-only + serial, matching the other specs. One magic-link send.
 */

const TEST_EMAIL = `e2e-apikey-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
const TEST_NAME = 'Key Tester';

test.describe('create-key e2e — expiry presets and the custom reveal', () => {
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'Aligns with the other specs (Chromium-only harness).'
	);

	// One ordered scenario: the authenticated session must persist across steps.
	test.describe.configure({ mode: 'serial' });

	test.afterAll(async () => {
		// Order matters, and neither of the first two cascades from the user:
		// `api_key.reference_id` carries no FK at all, and `audit_log.actor_user_id`
		// is `restrict` with a NULL `group_id` on key-management rows (so there's no
		// group delete to sweep them). Both must go before the user.
		await deleteApiKeysOwnedBy(TEST_EMAIL);
		await deleteAuditRowsActedBy(TEST_EMAIL);
		await deleteUserByEmail(TEST_EMAIL);
	});

	test('a preset expiry mints a key, and custom-days shows only for Custom', async ({
		page,
		baseURL
	}) => {
		expect(baseURL, 'playwright baseURL must be set').toBeTruthy();

		// ── Authenticate: ONE magic-link send, then follow the link ─────────────────
		await page.goto('/register');
		await page.getByLabel('Email').fill(TEST_EMAIL);
		await page.getByLabel('Display name').fill(TEST_NAME);
		await page.getByRole('button', { name: 'Send sign-in link' }).click();
		await expect(page.getByText('Check your email for a sign-in link')).toBeVisible();

		const verifyUrl = await getLatestMagicLinkUrlFor(TEST_EMAIL, { baseURL: baseURL as string });
		await page.goto(verifyUrl);
		await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

		// ── The reveal: custom-days is hidden until Custom is actually chosen ───────
		await page.goto('/settings/api-keys/new');
		await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();

		const customDays = page.getByLabel('Custom expiry (days)');
		// Locate the expiry radios by VALUE, not by accessible name: some options carry
		// hint text ("Custom — Set the number of days below"), so the name is not the
		// bare label.
		const expiry = (value: string) => page.locator(`input[name="expiry"][value="${value}"]`);

		// "Never" is the default choice, so the field must NOT be showing.
		await expect(customDays).toBeHidden();

		// Each preset likewise keeps it hidden…
		for (const preset of ['30', '90', '365']) {
			await expiry(preset).check();
			await expect(customDays).toBeHidden();
		}

		// …and Custom reveals it (the CSS `:has()` rule firing on `:checked`).
		await expiry('custom').check();
		await expect(customDays).toBeVisible();

		// Going back to a preset hides it again — the reveal is not one-way.
		await expiry('never').check();
		await expect(customDays).toBeHidden();

		// ── THE REGRESSION: a preset must submit after the custom field was TOUCHED ──
		// The reported bug. Svelte's number binding writes `null` into `customDays`
		// once the input has been typed in and cleared — and `z.coerce.number()` turns
		// `null` into `0`, which failed the ≥1 bound. So the client validator pinned an
		// error on a field the user wasn't even using, and EVERY preset was rejected
		// until they refilled it. Touch-then-clear is the trigger; a pristine field
		// never reproduced it, which is why this needs a browser.
		await page.getByLabel('Key name').fill('Preset key');
		await expiry('custom').check();
		await customDays.fill('5');
		await customDays.fill('');

		await expiry('90').check();
		await page.getByRole('button', { name: 'Create key' }).click();

		// Success = the one-time reveal screen. (Before the fix, the page just sat
		// there with "Choose at least 1 day" under the now-hidden custom field.)
		await page.waitForURL(/\/settings\/api-keys\/created$/);
		await expect(page.getByText('Preset key')).toBeVisible();

		// ── Custom still works, and still enforces its bounds ───────────────────────
		await page.goto('/settings/api-keys/new');
		await page.getByLabel('Key name').fill('Custom key');
		await expiry('custom').check();

		// An out-of-range custom value is still rejected — the fix loosened the empty
		// case, not the bound that keeps the plugin from 400ing (§16.8).
		await page.getByLabel('Custom expiry (days)').fill('400');
		await page.getByRole('button', { name: 'Create key' }).click();
		await expect(page.getByText('Choose at most 365 days')).toBeVisible();

		// A valid one mints.
		await page.getByLabel('Custom expiry (days)').fill('14');
		await page.getByRole('button', { name: 'Create key' }).click();
		await page.waitForURL(/\/settings\/api-keys\/created$/);
		await expect(page.getByText('Custom key')).toBeVisible();
	});
});
