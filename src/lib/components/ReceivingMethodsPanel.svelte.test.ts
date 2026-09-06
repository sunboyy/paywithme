import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ReceivingMethodsPanel from './ReceivingMethodsPanel.svelte';
import type { ReceivingProfileView } from '$lib/receiving-method-view';

// Client spec for the "how to pay them" panel (issue #86; PLAN §17.2–§17.4).
//
// The fixtures below are a rail this app has never heard of, for the same reason
// `ReceivingMethodFields.svelte.test.ts` invents one: the panel must not know a
// rail. It branches only on a field's PAYER ROLE — which value carries the copy
// affordance, which name the instruction points at — so a leaked rail id would
// show up here first.
//
// What is asserted is what a payer would lose if it broke:
//   - the FIRST method is the answer; the rest are behind "other ways to pay";
//   - the name-check instruction is present whenever any method renders, as real
//     text outside every fold (PLAN §17.2 — it is the only defence against a
//     valid-but-wrong account number);
//   - the three empty states say three different things (PLAN §17.4).

afterEach(cleanup);

const INVITE_URL = 'https://pay.example/invite/tok_abc123';
const MEMBERS_HREF = '/groups/g1/members';

/** An invented rail with the same two payer roles the shipped ones carry. */
const FIRST: ReceivingProfileView & { state: 'methods' } = {
	state: 'methods',
	methods: [
		{
			id: 'rm1',
			railLabel: 'Ruritanian bank',
			fields: [
				{ label: 'Bank', value: 'First Bank of Ruritania' },
				{ label: 'Account number', value: '1234567890', payerRole: 'copy' },
				{ label: 'Account holder name', value: 'Nan Suphaporn', payerRole: 'name-check' }
			]
		},
		{
			id: 'rm2',
			railLabel: 'Instant proxy',
			fields: [
				{ label: 'Proxy', value: '0812345678', payerRole: 'copy' },
				{ label: 'Account holder name', value: 'Nan Suphaporn', payerRole: 'name-check' }
			]
		}
	]
};

function renderPanel(view: ReceivingProfileView, inviteUrl: string | null = INVITE_URL) {
	return render(ReceivingMethodsPanel, {
		props: { view, displayName: 'Nan', inviteUrl, invitesHref: MEMBERS_HREF }
	});
}

describe('a member with more than one receiving method', () => {
	it('shows the first one, and only the first, outside the fold', () => {
		const { container } = renderPanel(FIRST);

		const fold = container.querySelector('[data-testid="receiving-other-ways"]');
		const methods = container.querySelectorAll('[data-testid="receiving-method"]');
		expect(methods).toHaveLength(2);

		// Preference IS the order (PLAN §17.1): the first is the answer on offer.
		expect(fold?.contains(methods[0])).toBe(false);
		expect(methods[0].textContent).toContain('1234567890');
		expect(fold?.contains(methods[1])).toBe(true);
		expect(methods[1].textContent).toContain('0812345678');
	});

	it('puts the rest behind a native, closed-by-default disclosure', () => {
		const { container } = renderPanel(FIRST);

		const fold = container.querySelector<HTMLDetailsElement>(
			'details[data-testid="receiving-other-ways"]'
		);
		// A <details>, so the fold opens with JS disabled.
		expect(fold).not.toBeNull();
		expect(fold!.open).toBe(false);
		expect(fold!.querySelector('summary')?.textContent).toContain('Other ways to pay Nan');
	});

	it('offers no fold at all when there is only one method', () => {
		const { container } = renderPanel({ state: 'methods', methods: [FIRST.methods[0]] });

		expect(container.querySelector('[data-testid="receiving-other-ways"]')).toBeNull();
		expect(container.querySelectorAll('[data-testid="receiving-method"]')).toHaveLength(1);
	});
});

describe('the name check (PLAN §17.2)', () => {
	it('states the comparison as an instruction whenever a method renders', () => {
		for (const view of [
			FIRST,
			{ state: 'methods', methods: [FIRST.methods[0]] } as ReceivingProfileView,
			// A rail with NO holder name at all (the `other` escape hatch): the payer
			// is still told to check the name, because that is the only defence there
			// is against a number that is valid but wrong.
			{
				state: 'methods',
				methods: [
					{
						id: 'rm9',
						railLabel: 'Other',
						fields: [
							{ label: 'Label', value: 'Wise (EUR)' },
							{ label: 'Payment details', value: 'IBAN DE89…', payerRole: 'copy' as const }
						]
					}
				]
			} as ReceivingProfileView
		]) {
			const { container, unmount } = renderPanel(view);

			const note = container.querySelector('[data-testid="receiving-name-check"]');
			expect(note).not.toBeNull();
			expect(note!.textContent).toMatch(/check the name/i);
			expect(note!.textContent).toMatch(/must match/i);
			unmount();
		}
	});

	it('keeps the instruction out of every fold, so it is read before anything is copied', () => {
		const { container } = renderPanel(FIRST);

		const note = container.querySelector('[data-testid="receiving-name-check"]')!;
		// Not inside a <details>, and not a title/aria hint on some icon.
		expect(note.closest('details')).toBeNull();
		expect(note.textContent?.trim().length).toBeGreaterThan(40);
	});

	it('is absent when there is nothing to pay into', () => {
		const { container } = renderPanel({ state: 'no-methods' });

		expect(container.querySelector('[data-testid="receiving-name-check"]')).toBeNull();
	});
});

describe('the copy affordance', () => {
	it('sits on the value a payer types into their bank, and nowhere else', () => {
		const { container } = renderPanel({ state: 'methods', methods: [FIRST.methods[0]] });

		const buttons = container.querySelectorAll('button');
		expect(buttons).toHaveLength(1);
		expect(buttons[0].getAttribute('aria-label')).toBe('Copy account number');
	});

	it('renders every value as selectable text, so copying works without JS', () => {
		const { getByText } = renderPanel({ state: 'methods', methods: [FIRST.methods[0]] });

		expect(getByText('1234567890').className).toContain('select-all');
		expect(getByText('Nan Suphaporn')).toBeTruthy();
	});
});

describe('empty state 1 — an unlinked member (PLAN §17.4)', () => {
	it('says there is no account yet and hands over the group’s invite link', () => {
		const { container, getByText } = renderPanel({ state: 'unlinked' });

		expect(getByText('No account yet — invite them')).toBeTruthy();

		const link = container.querySelector<HTMLAnchorElement>(
			'[data-testid="receiving-invite-link"]'
		);
		expect(link?.getAttribute('href')).toBe(INVITE_URL);
		// The URL is its own text too — that is what gets pasted into a chat.
		expect(link?.textContent?.trim()).toBe(INVITE_URL);
	});

	it('points at the members screen when the group has no active link to give', () => {
		// Creating one is a mutation, so it can never happen in a page `load`.
		const { container, queryByTestId } = renderPanel({ state: 'unlinked' }, null);

		expect(queryByTestId('receiving-invite-link')).toBeNull();
		expect(container.querySelector(`a[href="${MEMBERS_HREF}"]`)).not.toBeNull();
	});
});

describe('empty state 2 — linked, but nothing recorded (PLAN §17.4)', () => {
	it('says only that, because v1 cannot nudge them', () => {
		const { container } = renderPanel({ state: 'no-methods' });

		const text = container.textContent ?? '';
		expect(text).toMatch(/Nan hasn.t added a receiving method\./);
		// No invite link (they already have an account) and nothing that sounds like
		// a reminder the app cannot send.
		expect(container.querySelector('[data-testid="receiving-invite-link"]')).toBeNull();
		expect(text).not.toMatch(/remind|notify|ask them to add/i);
	});
});

describe('details the rail refuses to render', () => {
	it('says so instead of showing part of an account number', () => {
		const { container } = renderPanel({
			state: 'methods',
			methods: [{ id: 'rm1', railLabel: 'Ruritanian bank', fields: null }]
		});

		expect(container.textContent).toMatch(/can.t be shown right now/i);
		expect(container.querySelector('button')).toBeNull();
	});
});
