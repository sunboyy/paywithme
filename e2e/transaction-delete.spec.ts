import { expect, test } from '@playwright/test';
import { deleteGroupsCreatedBy, deleteUserByEmail, getLatestMagicLinkUrlFor } from './support/db';

/**
 * Soft-delete and restore a transaction (PLAN §9, §12.1).
 *
 * Flow:
 *   register → create group → add member → add transaction →
 *   open detail → delete (via AlertDialog confirm) → verify list hides it →
 *   re-open detail → restore → verify banner gone.
 *
 * AUTH: single magic-link send to stay within the rate limit (5/60s per IP).
 * Chromium-only + serial, matching the other e2e specs.
 */

const TEST_EMAIL = `e2e-delete-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
const TEST_NAME = 'Delete Tester';
const OTHER_MEMBER = 'Alice';
const GROUP_NAME = `Delete Test ${Date.now()}`;
const TX_TITLE = 'Lunch';

test.describe('transaction soft-delete and restore', () => {
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'Aligns with the other specs (Chromium-only harness).'
	);

	test.describe.configure({ mode: 'serial' });

	test.afterAll(async () => {
		await deleteGroupsCreatedBy(TEST_EMAIL);
		await deleteUserByEmail(TEST_EMAIL);
	});

	test('soft-delete hides the transaction; restore brings it back', async ({ page, baseURL }) => {
		expect(baseURL, 'playwright baseURL must be set').toBeTruthy();
		const appBaseURL = baseURL as string;

		// ── Authenticate ──────────────────────────────────────────────────────────
		await page.goto('/register');
		await page.getByLabel('Email').fill(TEST_EMAIL);
		await page.getByLabel('Display name').fill(TEST_NAME);
		await page.getByRole('button', { name: 'Send sign-in link' }).click();
		await expect(page.getByText('Check your email for a sign-in link')).toBeVisible();

		const verifyUrl = await getLatestMagicLinkUrlFor(TEST_EMAIL, { baseURL: appBaseURL });
		await page.goto(verifyUrl);
		await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

		// ── Create group (USD) ────────────────────────────────────────────────────
		await page.goto('/groups/new');
		await page.getByLabel('Group name').fill(GROUP_NAME);
		await page.getByRole('combobox').click();
		await page.getByPlaceholder('Search currency…').fill('USD');
		await page.getByRole('option', { name: /USD/ }).click();
		await page.getByRole('button', { name: 'Create group' }).click();

		await page.waitForURL(/\/groups\/?$/);
		await page.getByRole('link', { name: GROUP_NAME }).click();
		await page.waitForURL(/\/groups\/[^/]+$/);
		const groupId = new URL(page.url()).pathname.split('/')[2];
		expect(groupId).toBeTruthy();

		// ── Add a second member ───────────────────────────────────────────────────
		await page
			.getByRole('navigation', { name: 'Group sections' })
			.getByRole('link', { name: 'Members' })
			.click();
		await page.waitForURL(/\/groups\/[^/]+\/members$/);
		await page.getByLabel('Add a member').fill(OTHER_MEMBER);
		await page.getByRole('button', { name: 'Add member' }).click();
		await expect(
			page.getByRole('list', { name: 'Group members' }).getByText(OTHER_MEMBER, { exact: true })
		).toBeVisible();

		// ── Add a transaction ─────────────────────────────────────────────────────
		await page.goto(`/groups/${groupId}/transactions/new`);
		await page.getByLabel('Title').fill(TX_TITLE);
		await page.getByLabel('Amount').fill('20.00');
		await page.getByRole('button', { name: 'Add transaction' }).click();
		await page.waitForURL(`**/groups/${groupId}/transactions`);

		// Verify it appears in the list before deleting.
		await expect(page.getByRole('link', { name: new RegExp(TX_TITLE) })).toBeVisible();

		// ── Open the transaction detail page ──────────────────────────────────────
		await page.getByRole('link', { name: new RegExp(TX_TITLE) }).click();
		await page.waitForURL(/\/groups\/[^/]+\/transactions\/[^/]+$/);
		const txUrl = page.url();

		// ── Delete: click trigger → dialog opens → confirm ────────────────────────
		// The AlertDialog trigger opens the confirmation dialog.
		await page.getByRole('button', { name: 'Delete' }).click();
		// Wait for the dialog to appear.
		await expect(page.getByRole('alertdialog')).toBeVisible();
		await expect(page.getByRole('alertdialog')).toContainText(TX_TITLE);

		// The "Delete transaction" action button (portalled outside the form) now
		// submits via the HTML5 `form` attribute (see the fix in +page.svelte).
		await page.getByRole('button', { name: 'Delete transaction' }).click();

		// Soft-delete redirects to the transaction list.
		await page.waitForURL(`**/groups/${groupId}/transactions`);

		// The deleted transaction is hidden from the list (PLAN §9).
		await expect(page.getByRole('link', { name: new RegExp(TX_TITLE) })).toHaveCount(0);

		// ── Re-open the detail URL: should show the deleted banner ────────────────
		await page.goto(txUrl);
		await expect(page.getByText('This transaction was deleted.')).toBeVisible();

		// The Restore button should be present but not the Edit/Delete controls.
		await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);

		// ── Restore: click Restore → banner disappears ────────────────────────────
		await page.getByRole('button', { name: 'Restore' }).click();
		await page.waitForURL(txUrl);

		// The deleted banner is gone; the transaction is live again.
		await expect(page.getByText('This transaction was deleted.')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

		// It's back in the list too.
		await page.goto(`/groups/${groupId}/transactions`);
		await expect(page.getByRole('link', { name: new RegExp(TX_TITLE) })).toBeVisible();
	});
});
