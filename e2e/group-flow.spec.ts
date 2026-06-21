import { expect, test } from '@playwright/test';
import { deleteGroupsCreatedBy, deleteUserByEmail, getLatestMagicLinkUrlFor } from './support/db';

/**
 * Phase 3–6 core happy-path end-to-end (task 8.4, PLAN §13 E2E bullet):
 *
 *   create group → add member → add a split transaction → settle →
 *   balances zero out; the activity feed shows actions newest-first with the
 *   right actor.
 *
 * One ordered scenario in a single page/context so the authenticated session and
 * all created state (group, members, transactions) persist across steps — mirrors
 * `e2e/auth.spec.ts`.
 *
 * AUTH: register via exactly ONE magic-link send (captured from the DB, like
 * auth.spec.ts) and stay logged in. The magic-link SEND rate limit is 5/60s per
 * IP and all e2e share one IP, so a single send here leaves ample headroom under
 * the cap (auth.spec.ts makes two). No passkey enrol is needed for this flow.
 *
 * Chromium-only + serial, matching the other specs.
 *
 * Money: USD (a 2-decimal settlement currency) keeps the amounts simple. The
 * acting user pays $10 split equally between two members ($5 each), so the second
 * member owes the acting user $5; settling that transfer squares everyone up.
 */

const TEST_EMAIL = `e2e-flow-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
// The acting user's display name — captured on register and used as their member
// display name and as the actor name in the activity feed.
const TEST_NAME = 'Flow Tester';
// A second, account-less participant so there's a real multi-member split.
const OTHER_MEMBER = 'Bob';
// The group and the spending transaction we create + assert on.
const GROUP_NAME = `Trip ${Date.now()}`;
const TX_TITLE = 'Dinner';

test.describe('group flow e2e — create → split → settle → activity', () => {
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'Aligns with the other specs (Chromium-only harness).'
	);

	// One ordered scenario: auth + every created entity must persist across steps.
	test.describe.configure({ mode: 'serial' });

	test.afterAll(async () => {
		// Clean up this run's data. The acting user CREATED a group, and
		// `groups.created_by_user_id` is `restrict`, so drop their groups FIRST (this
		// cascades to members/invites/transactions/audit), THEN delete the user +
		// their verification rows. Self-contained: depends only on the unique email.
		await deleteGroupsCreatedBy(TEST_EMAIL);
		await deleteUserByEmail(TEST_EMAIL);
	});

	test('create a group, split a spend, settle it, and read the activity feed', async ({
		page,
		baseURL
	}) => {
		expect(baseURL, 'playwright baseURL must be set').toBeTruthy();
		const appBaseURL = baseURL as string;

		// ── Authenticate: ONE magic-link send, then follow the link (stay logged in) ──
		await page.goto('/register');
		await page.getByLabel('Email').fill(TEST_EMAIL);
		await page.getByLabel('Display name').fill(TEST_NAME);
		await page.getByRole('button', { name: 'Send sign-in link' }).click();
		await expect(page.getByText('Check your email for a sign-in link')).toBeVisible();

		const verifyUrl = await getLatestMagicLinkUrlFor(TEST_EMAIL, { baseURL: appBaseURL });
		await page.goto(verifyUrl);

		// A brand-new named user with no passkey lands on the onboarding nudge; the
		// signed-in chrome shows the display name (the actor for everything below).
		await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
		await expect(page.getByText(TEST_NAME)).toBeVisible();

		// ── Create a group (USD = 2-decimal settlement currency) ─────────────────────
		await page.goto('/groups/new');
		await expect(page.getByRole('heading', { name: 'New group' })).toBeVisible();
		await page.getByLabel('Group name').fill(GROUP_NAME);
		// The currency picker is a searchable combobox after hydration. Open it, search
		// for USD, and pick it (no-JS fallback is a native select; here JS is on).
		await page.getByRole('combobox').click();
		await page.getByPlaceholder('Search currency…').fill('USD');
		await page.getByRole('option', { name: /USD/ }).click();
		await page.getByRole('button', { name: 'Create group' }).click();

		// Create redirects to the groups list; open the new group — its card lands on
		// the group overview.
		await page.waitForURL(/\/groups\/?$/);
		await page.getByRole('link', { name: GROUP_NAME }).click();
		await page.waitForURL(/\/groups\/[^/]+$/);
		// Capture the group id from the URL so the rest of the flow navigates directly.
		const groupId = new URL(page.url()).pathname.split('/')[2];
		expect(groupId).toBeTruthy();

		// Reach the roster via the shared group navigation's "Members" tab.
		await page
			.getByRole('navigation', { name: 'Group sections' })
			.getByRole('link', { name: 'Members' })
			.click();
		await page.waitForURL(/\/groups\/[^/]+\/members$/);

		// The acting user is auto-added as a member (PLAN §6.1); the roster shows them
		// with a "You" badge.
		const memberList = page.getByRole('list', { name: 'Group members' });
		await expect(memberList).toBeVisible();
		// `exact: true`: the name also appears inside per-row control labels (e.g. the
		// "Remove <name>" button), so match only the bare display-name span.
		await expect(memberList.getByText(TEST_NAME, { exact: true })).toBeVisible();

		// ── Add a second (account-less) member so there's a multi-member split ───────
		await page.getByLabel('Add a member').fill(OTHER_MEMBER);
		await page.getByRole('button', { name: 'Add member' }).click();
		await expect(memberList.getByText(OTHER_MEMBER, { exact: true })).toBeVisible();

		// ── Add a spending transaction: $10 split EQUALLY, paid by the acting user ───
		// Simplest path that creates a real debt: spending / equal / single payer.
		await page.goto(`/groups/${groupId}/transactions/new`);
		await expect(page.getByRole('heading', { name: 'Add transaction' })).toBeVisible();
		await page.getByLabel('Title').fill(TX_TITLE);
		await page.getByLabel('Amount').fill('10.00');

		// Defaults already are: Spending, Equal split, payer = the acting user,
		// beneficiaries = all active members. Assert both members are checked
		// beneficiaries (the $5/$5 equal split) so the debt is well-defined.
		const splitBetween = page.getByRole('group', { name: 'Split between' });
		await expect(splitBetween.getByRole('checkbox', { name: TEST_NAME })).toBeChecked();
		await expect(splitBetween.getByRole('checkbox', { name: OTHER_MEMBER })).toBeChecked();
		// The acting user is the (single) default payer.
		const paidBy = page.getByRole('group', { name: 'Paid by' });
		await expect(paidBy.getByRole('checkbox', { name: TEST_NAME })).toBeChecked();

		await page.getByRole('button', { name: 'Add transaction' }).click();

		// Redirects to the transaction list; the new spend appears.
		await page.waitForURL(`**/groups/${groupId}/transactions`);
		// The shared GroupNav marks the current section with aria-current="page".
		await expect(
			page.locator('nav[aria-label="Group sections"] a[aria-current="page"]')
		).toHaveText('Transactions');
		const txLink = page.getByRole('link', { name: new RegExp(TX_TITLE) });
		await expect(txLink).toBeVisible();

		// ── Balances reflect who owes whom (settle page) ─────────────────────────────
		await page.goto(`/groups/${groupId}/settle`);
		await expect(
			page.locator('nav[aria-label="Group sections"] a[aria-current="page"]')
		).toHaveText('Settle up');

		// Bob is the debtor ($5 owed); the acting user is owed $5. The balances list
		// surfaces both an "owes" and an "is owed" badge (so it is NOT all-settled).
		const balances = page.getByRole('list', { name: 'Member balances' });
		await expect(balances.getByText('owes')).toBeVisible();
		await expect(balances.getByText('is owed')).toBeVisible();
		// Not settled yet → no cleared state.
		await expect(page.getByText('All settled up')).toHaveCount(0);

		// A suggested settlement appears: the debtor (Bob) pays the creditor (the
		// acting user). Follow its "Settle up" prefill to record the transfer.
		const suggestions = page.getByRole('list', { name: 'Suggested settlements' });
		const suggestion = suggestions.getByRole('listitem').first();
		await expect(suggestion).toContainText(OTHER_MEMBER);
		await expect(suggestion).toContainText(TEST_NAME);
		await suggestion.getByRole('link', { name: 'Settle up' }).click();

		// The prefill lands on the add page as a Transfer (payer = Bob, recipient =
		// the acting user, the $5 amount, Debt settlement category). Give it a title
		// (required) and submit to actually record the settlement.
		await page.waitForURL(`**/groups/${groupId}/transactions/new?**`);
		await expect(page.getByRole('heading', { name: 'Add transaction' })).toBeVisible();
		// The type toggle is prefilled to Transfer.
		await expect(page.getByRole('tab', { name: 'Transfer', selected: true })).toBeVisible();
		await page.getByLabel('Title').fill('Settle up');
		await page.getByRole('button', { name: 'Add transaction' }).click();
		await page.waitForURL(`**/groups/${groupId}/transactions`);

		// ── Balances zero out: the settle page shows the cleared "All settled up" ────
		await page.goto(`/groups/${groupId}/settle`);
		await expect(
			page.locator('nav[aria-label="Group sections"] a[aria-current="page"]')
		).toHaveText('Settle up');
		// The shared EmptyState cleared card (task 8.1) — assert by its visible text,
		// not a brittle selector.
		await expect(page.getByText('All settled up')).toBeVisible();
		// And there are no outstanding suggestions / debtor badges left.
		await expect(page.getByRole('list', { name: 'Suggested settlements' })).toHaveCount(0);
		await expect(page.getByRole('list', { name: 'Member balances' }).getByText('owes')).toHaveCount(
			0
		);

		// ── Activity feed: newest-first, attributed to the right actor ───────────────
		await page.goto(`/groups/${groupId}/activity`);
		await expect(
			page.locator('nav[aria-label="Group sections"] a[aria-current="page"]')
		).toHaveText('Activity');

		// Every entry shows the acting user as the actor (they performed every action
		// in this run). The <time> elements are rendered newest-first.
		const times = page.locator('time[datetime]');
		const count = await times.count();
		expect(count).toBeGreaterThanOrEqual(4); // group create + member add + 2 txns

		// Assert strict newest-first ordering on the durable ISO timestamps.
		const isos = await times.evaluateAll((nodes) =>
			nodes.map((n) => (n as HTMLTimeElement).getAttribute('datetime') ?? '')
		);
		const sortedDesc = [...isos].sort((a, b) => b.localeCompare(a));
		expect(isos).toEqual(sortedDesc);

		// The most recent action is at the TOP and is a transaction created by the
		// acting user — the settling transfer (the last thing we did).
		const entries = page.locator('time[datetime]').locator('xpath=ancestor::div[1]');
		const newest = entries.first();
		await expect(newest.getByText(TEST_NAME)).toBeVisible();
		await expect(newest.getByText('created')).toBeVisible();
		await expect(newest.getByText('transaction', { exact: false })).toBeVisible();

		// The feed lists the earlier group-creation / member / transaction actions
		// below the newest one — the spending transaction's title and the group name
		// both appear somewhere in the feed body.
		const feed = page.getByText(TX_TITLE);
		await expect(feed.first()).toBeVisible();
		await expect(page.getByText(GROUP_NAME).first()).toBeVisible();
	});
});
