import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Client spec for the settle screen's receiving-details disclosure (issue #86;
// PLAN §8.4, §17.3–§17.4).
//
// This is where the feature pays off: the debtor is looking at "you pay Nan
// ฿1,200" and needs the account to send it to. What the page owes, and what
// breaking it would cost:
//
//   - ON DEMAND, never inline (§17.3). The row itself stays a row; the details
//     live in a native <details> that is CLOSED on arrival and opens with JS
//     disabled.
//   - One disclosure per suggested transfer, naming the creditor — a payer with
//     three transfers to make must not have to guess which account is whose.
//
// The panel's own contents (first method, the fold, the name check, the empty
// states) are specified in `lib/components/ReceivingMethodsPanel.svelte.test.ts`;
// this file checks the wiring around it.
//
// Issue #87 adds the one case addressed to the VIEWER: when they are the creditor
// and their own profile is empty, the same disclosure offers the link to
// `/settings/receiving` (PLAN §17.4 case 3). The route decides that — `own-empty`
// arrives in `data.receiving` — so what this file checks is that the page renders
// it, and renders nothing like it for anyone else's blank.

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));

afterEach(cleanup);

/**
 * The one suggested transfer the fixtures below describe.
 *
 * Receiving details are keyed by TRANSFER, not by creditor (issue #88): one person
 * can be owed by two others for two different amounts, and each row's QR carries
 * its own figure.
 */
const TRANSFER = 'm2→m1';

const BANK: PageData['receiving'][string] = {
	state: 'methods',
	methods: [
		{
			id: 'rm1',
			railLabel: 'Thai bank account',
			fields: [
				{ label: 'Bank', value: 'Kasikornbank (KBank)' },
				{ label: 'Account number', value: '1234567890', payerRole: 'copy' },
				{ label: 'Account holder name', value: 'Nan Suphaporn', payerRole: 'name-check' }
			]
		}
	]
};

function pageData(overrides: Partial<PageData> = {}): PageData {
	return {
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		currency: { code: 'THB', symbol: '฿', exponent: 2 },
		balances: [
			{
				memberId: 'm1',
				displayName: 'Nan',
				balance: 120000,
				balanceFormatted: '฿1,200.00',
				isDebtor: false,
				isCreditor: true,
				isActive: true
			},
			{
				memberId: 'm2',
				displayName: 'Bob',
				balance: -120000,
				balanceFormatted: '-฿1,200.00',
				isDebtor: true,
				isCreditor: false,
				isActive: true
			}
		],
		suggestions: [
			{
				key: TRANSFER,
				fromMemberId: 'm2',
				toMemberId: 'm1',
				fromDisplayName: 'Bob',
				toDisplayName: 'Nan',
				amount: 120000,
				amountFormatted: '฿1,200.00'
			}
		],
		allSettled: false,
		receiving: { [TRANSFER]: BANK },
		inviteUrl: null,
		...overrides
	} as PageData;
}

function renderPage(data: PageData = pageData()) {
	return render(Page, { props: { data } });
}

describe('the suggested-transfer row', () => {
	it('shows the creditor’s details on demand, in a disclosure that starts closed', () => {
		const { container } = renderPage();

		const details = container.querySelector<HTMLDetailsElement>('[data-testid="how-to-pay"]');
		expect(details).not.toBeNull();
		expect(details!.open).toBe(false);
		// A native <details>: it opens with JS disabled (§17.3 "shown on demand").
		expect(details!.tagName).toBe('DETAILS');
		expect(details!.querySelector('summary')?.textContent).toContain('How to pay Nan');
	});

	it('never prints the account details in the row itself (§17.3)', () => {
		const { container } = renderPage();

		const details = container.querySelector('[data-testid="how-to-pay"]')!;
		const accountNumber = [...container.querySelectorAll('span')].find(
			(el) => el.textContent === '1234567890'
		);

		expect(accountNumber).toBeTruthy();
		expect(details.contains(accountNumber!)).toBe(true);
	});

	it('states the name check inside the disclosure it belongs to', () => {
		const { container } = renderPage();

		const note = container.querySelector('[data-testid="receiving-name-check"]');
		expect(note?.textContent).toMatch(/check the name/i);
	});

	it('gives each transfer its own disclosure, named after its creditor', () => {
		// Three transfers to make means three different accounts — the payer must
		// never have to work out which one belongs to whom.
		const { container } = renderPage(
			pageData({
				suggestions: [
					{
						key: TRANSFER,
						fromMemberId: 'm2',
						toMemberId: 'm1',
						fromDisplayName: 'Bob',
						toDisplayName: 'Nan',
						amount: 120000,
						amountFormatted: '฿1,200.00'
					},
					{
						key: 'm2→m3',
						fromMemberId: 'm2',
						toMemberId: 'm3',
						fromDisplayName: 'Bob',
						toDisplayName: 'Alex',
						amount: 5000,
						amountFormatted: '฿50.00'
					}
				],
				receiving: { [TRANSFER]: BANK, 'm2→m3': { state: 'no-methods' } }
			})
		);

		const summaries = [...container.querySelectorAll('[data-testid="how-to-pay"] summary')].map(
			(s) => s.textContent?.trim()
		);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]).toContain('How to pay Nan');
		expect(summaries[1]).toContain('How to pay Alex');
	});

	it('shows the row’s own code, with that row’s amount (issue #88)', () => {
		// The route builds the code per transfer; the page's job is to put it in the
		// right row's disclosure. A code from another row is a payment to the right
		// person for the wrong figure.
		const { container } = renderPage(
			pageData({
				receiving: {
					[TRANSFER]: {
						state: 'methods',
						methods: [
							{
								id: 'rm1',
								railLabel: 'PromptPay',
								qr: { size: 33, path: 'M4 4h7v1h-7z', amountFormatted: '฿1,200.00' },
								fields: [
									{ label: 'PromptPay number', value: '0812345678', payerRole: 'copy' },
									{ label: 'Account holder name', value: 'Nan Suphaporn', payerRole: 'name-check' }
								]
							}
						]
					}
				}
			})
		);

		const disclosure = container.querySelector('[data-testid="how-to-pay"]')!;
		const qr = disclosure.querySelector('[data-testid="receiving-qr"]');
		expect(qr).not.toBeNull();
		expect(qr!.textContent).toContain('฿1,200.00');
	});

	it('offers the invite link when the creditor has no account yet (§17.4)', () => {
		const { container } = renderPage(
			pageData({
				receiving: { [TRANSFER]: { state: 'unlinked' } },
				inviteUrl: 'http://localhost/invite/tok_abc'
			})
		);

		expect(container.textContent).toContain('No account yet — invite them');
		expect(
			container.querySelector('[data-testid="receiving-invite-link"]')?.getAttribute('href')
		).toBe('http://localhost/invite/tok_abc');
	});

	it('keeps the "Settle up" prefill link alongside the details (§8.4)', () => {
		const { container } = renderPage();

		// The prefill link, not the nav's own "Settle up" tab.
		const settle = [...container.querySelectorAll('a')].find((a) =>
			a.getAttribute('href')?.includes('type=transfer')
		);
		expect(settle?.getAttribute('href')).toContain('from=m2');
		expect(settle?.getAttribute('href')).toContain('to=m1');
		expect(settle?.getAttribute('href')).toContain('amount=120000');
	});
});

describe('when everyone is square', () => {
	it('renders no receiving disclosure at all', () => {
		const { container } = renderPage(
			pageData({ suggestions: [], allSettled: true, receiving: {} })
		);

		expect(container.querySelector('[data-testid="how-to-pay"]')).toBeNull();
	});

	it('does not ask a settled member for their bank details (issue #87)', () => {
		// Nobody owes them anything, so there is no reason yet to care — and an ask
		// with no reason behind it is the onboarding step PLAN §17.4 refuses to add.
		const { container } = renderPage(
			pageData({ suggestions: [], allSettled: true, receiving: {} })
		);

		expect(container.textContent).not.toMatch(/Add how people should pay you/);
	});
});

describe('the viewer’s own empty profile (issue #87; PLAN §17.4 case 3)', () => {
	/** The single suggestion, with the creditor's profile in whatever state. */
	function withCreditorProfile(state: PageData['receiving'][string]) {
		return renderPage(pageData({ receiving: { [TRANSFER]: state } }));
	}

	it('offers the editor link when the creditor is the viewer and has nothing recorded', () => {
		const { getByText } = withCreditorProfile({ state: 'own-empty' });

		const link = getByText(/Add how people should pay you/).closest('a');
		expect(link?.getAttribute('href')).toBe('/settings/receiving');
	});

	it('opens that row on arrival, because nobody taps "How to pay <me>"', () => {
		// The disclosure exists for the DEBTOR, who opens it when they are ready to
		// pay. A creditor has no reason to open a fold about herself, so a prompt
		// left behind that tap is a prompt its audience never sees — and this one is
		// the whole adoption strategy (PLAN §17.4).
		const { container } = withCreditorProfile({ state: 'own-empty' });

		const details = container.querySelector<HTMLDetailsElement>('[data-testid="how-to-pay"]');
		expect(details!.open).toBe(true);
	});

	it('leaves every other row closed, so the debtor’s view is unchanged', () => {
		for (const state of [BANK, { state: 'no-methods' } as const, { state: 'unlinked' } as const]) {
			const { container, unmount } = withCreditorProfile(state);

			const details = container.querySelector<HTMLDetailsElement>('[data-testid="how-to-pay"]');
			expect(details!.open, state.state).toBe(false);
			unmount();
		}
	});

	it('stops offering it once they have added a method', () => {
		const { container } = withCreditorProfile(BANK);

		expect(container.querySelector('[data-testid="receiving-own-empty"]')).toBeNull();
		expect(container.textContent).not.toMatch(/Add how people should pay you/);
	});

	it('never shows it against somebody else’s empty profile', () => {
		// The viewer is the DEBTOR here: the blank belongs to the person they owe,
		// and nothing about it is theirs to fix.
		const { container } = withCreditorProfile({ state: 'no-methods' });

		expect(container.textContent).toMatch(/Nan hasn.t added a receiving method/);
		expect(container.textContent).not.toMatch(/Add how people should pay you/);
	});
});
