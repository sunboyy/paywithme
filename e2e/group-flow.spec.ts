import { expect, test } from '@playwright/test';
import { deleteGroupsCreatedBy, deleteUserByEmail, getLatestMagicLinkUrlFor } from './support/db';

/**
 * Phase 3–6 core happy-path end-to-end (task 8.4, PLAN §13 E2E bullet):
 *
 *   create group → add member → add a split transaction → settle →
 *   balances zero out; the activity feed shows actions newest-first with the
 *   right actor.
 *
 * ── The "Not recorded yet" leg (issue #53, PLAN §7.7) ────────────────────────
 * A second act runs on the SAME settled group: note a spending for later → the
 * unrecorded count appears on `/groups` and the group overview → the balances do
 * NOT move → record it → the count clears, the transaction joins the list, and the
 * balances move for the first time.
 *
 * It lives in THIS file rather than its own spec for a hard reason: the magic-link
 * SEND cap is 5/60s per IP, every e2e request shares one IP, and the four existing
 * specs already spend exactly five (auth ×2, the other three ×1). A sixth send
 * would push the suite over the cap and make an unrelated spec fail. Appending the
 * leg here reuses this test's session and its group and costs nothing — and a group
 * that has just settled to zero is the clearest possible backdrop for "a Capture
 * moved no balance": the screen still says "All settled up" until it is recorded.
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
// The record-later note (PLAN §7.7). Distinctive so it can be found in the tray,
// in the prefilled title, and later as the recorded transaction's own title.
const CAPTURE_NOTE = 'Night market snacks';

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

		// ══ "Not recorded yet" (issue #53; PLAN §7.7) ═══════════════════════════════
		// The group is settled to zero, which makes the next assertion unambiguous: a
		// Capture must leave it that way.

		// ── Note it for later: one screen, one required field ────────────────────────
		await page.goto(`/groups/${groupId}`);
		// Nothing waiting yet — the overview says so rather than showing a count.
		await expect(page.getByText('Nothing waiting.')).toBeVisible();
		await page.getByRole('link', { name: 'Note for later' }).click();
		await page.waitForURL(`**/groups/${groupId}/captures/new`);

		// The word "Capture" is INTERNAL vocabulary (PLAN §7.7): no user-facing string
		// says it, here or anywhere else this leg visits.
		await expect(page.getByRole('heading', { name: 'Note it for later' })).toBeVisible();
		await expect(page.locator('body')).not.toContainText('Capture');

		await page.getByLabel('What was it?').fill(CAPTURE_NOTE);
		// Optional money, in the group's own currency — the amount a Capture carries
		// is exactly the thing that must never reach a balance.
		await page.getByLabel(/Roughly how much/).fill('20.00');
		await page.getByRole('button', { name: 'Save' }).click();

		// ── The tray: above the transaction list, attributed to its author ──────────
		await page.waitForURL(`**/groups/${groupId}/transactions`);
		const tray = page.getByTestId('not-recorded-yet-tray');
		await expect(tray).toBeVisible();
		await expect(tray.getByText(CAPTURE_NOTE)).toBeVisible();
		// Attribution is what makes the tray deduplicate (§7.7 "Group-visible").
		await expect(tray.getByText(TEST_NAME)).toBeVisible();

		// ── The unrecorded count, on both recall surfaces (§7.7 "Recall (no push)") ──
		await page.goto('/groups');
		await expect(page.getByText('1 not recorded yet')).toBeVisible();
		await page.goto(`/groups/${groupId}`);
		await expect(page.getByText('1 note is waiting to be recorded.')).toBeVisible();

		// ── AND THE BALANCES HAVE NOT MOVED (the whole point) ───────────────────────
		// An open Capture carrying $20 is on screen in this group, and the settle page
		// is still cleared. Nothing that computes a balance can see it (§7.7).
		await page.goto(`/groups/${groupId}/settle`);
		await expect(page.getByText('All settled up')).toBeVisible();
		await expect(page.getByRole('list', { name: 'Suggested settlements' })).toHaveCount(0);

		// ── "Record it": the note becomes an ordinary transaction ───────────────────
		await page.goto(`/groups/${groupId}/transactions`);
		await tray.getByRole('link', { name: 'Record it' }).click();
		await page.waitForURL(/\/transactions\/new\?capture=/);
		// Prefilled from the note: the title and the amount. The split, the payers and
		// the category are NOT prefilled — a Capture holds none of them (ADR-0012).
		await expect(page.getByLabel('Title')).toHaveValue(CAPTURE_NOTE);
		await expect(page.getByLabel('Amount')).toHaveValue(/20/);
		await page.getByRole('button', { name: 'Add transaction' }).click();
		await page.waitForURL(`**/groups/${groupId}/transactions`);

		// ── The count clears and the transaction joins the list ─────────────────────
		await expect(page.getByTestId('not-recorded-yet-tray')).toHaveCount(0);
		await expect(page.getByRole('link', { name: CAPTURE_NOTE })).toBeVisible();
		await page.goto('/groups');
		await expect(page.getByText('not recorded yet')).toHaveCount(0);

		// ── … and the balances move, for the first time ─────────────────────────────
		await page.goto(`/groups/${groupId}/settle`);
		await expect(page.getByText('All settled up')).toHaveCount(0);
		const settledBalances = page.getByRole('list', { name: 'Member balances' });
		await expect(settledBalances.getByText('owes')).toBeVisible();
		await expect(settledBalances.getByText('is owed')).toBeVisible();

		// ── The audit trail reads correctly in the activity feed (§12.1) ────────────
		await page.goto(`/groups/${groupId}/activity`);
		// Both endings of the note are in the trail, under the label users read — the
		// stored `capture` entity type must never surface as the internal word.
		await expect(page.getByText('Not recorded yet').first()).toBeVisible();
		await expect(page.getByText(CAPTURE_NOTE).first()).toBeVisible();
		await expect(page.locator('body')).not.toContainText('Capture');
	});
});
