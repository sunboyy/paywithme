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

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));

afterEach(cleanup);

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
				fromMemberId: 'm2',
				toMemberId: 'm1',
				fromDisplayName: 'Bob',
				toDisplayName: 'Nan',
				amount: 120000,
				amountFormatted: '฿1,200.00'
			}
		],
		allSettled: false,
		receiving: { m1: BANK },
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
						fromMemberId: 'm2',
						toMemberId: 'm1',
						fromDisplayName: 'Bob',
						toDisplayName: 'Nan',
						amount: 120000,
						amountFormatted: '฿1,200.00'
					},
					{
						fromMemberId: 'm2',
						toMemberId: 'm3',
						fromDisplayName: 'Bob',
						toDisplayName: 'Alex',
						amount: 5000,
						amountFormatted: '฿50.00'
					}
				],
				receiving: { m1: BANK, m3: { state: 'no-methods' } }
			})
		);

		const summaries = [...container.querySelectorAll('[data-testid="how-to-pay"] summary')].map(
			(s) => s.textContent?.trim()
		);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]).toContain('How to pay Nan');
		expect(summaries[1]).toContain('How to pay Alex');
	});

	it('offers the invite link when the creditor has no account yet (§17.4)', () => {
		const { container } = renderPage(
			pageData({
				receiving: { m1: { state: 'unlinked' } },
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
});
