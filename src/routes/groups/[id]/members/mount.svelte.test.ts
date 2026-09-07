import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Client spec for MEMBER DETAIL as a receiving surface (issue #86; PLAN §17.3–§17.4).
//
// PLAN §17.4 asks for "the same, on demand" here as on the settle screen. There is
// no separate member-detail route (PLAN §10) — the detail IS this page's per-member
// disclosure, so that is where "how to pay them" belongs, opened by the same tap
// that already reveals the row's controls.
//
// The one thing this file exists to catch: the details must not be printed in the
// roster. §17.3 is explicit — visible to co-members, but shown on demand, never
// inline in a member list.

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));

afterEach(cleanup);

/** A superforms payload shaped as `superValidate` returns it for an empty form. */
function seededForm(id: string) {
	return { id, valid: true, posted: false, errors: {}, data: {} };
}

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
		viewerUserId: 'u1',
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		members: [
			{ id: 'm1', displayName: 'Nan', userId: 'u2', deactivatedAt: null, isLinked: true },
			{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false }
		],
		invites: [{ id: 'i1', token: 'tok_abc', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '' }],
		origin: 'http://localhost',
		receiving: { m1: BANK, m2: { state: 'unlinked' } },
		addForm: seededForm('add'),
		renameForm: seededForm('rename'),
		removeForm: seededForm('remove'),
		reactivateForm: seededForm('reactivate'),
		createInviteForm: seededForm('createInvite'),
		revokeInviteForm: seededForm('revokeInvite'),
		...overrides
	} as unknown as PageData;
}

function renderPage(data: PageData = pageData()) {
	return render(Page, { props: { data } });
}

describe('member detail', () => {
	it('puts "how to pay them" behind the member’s own disclosure, closed on arrival', () => {
		const { container } = renderPage();

		const rows = container.querySelectorAll<HTMLDetailsElement>(
			'ul[aria-label="Group members"] details'
		);
		expect(rows.length).toBeGreaterThan(0);

		const nan = rows[0];
		expect(nan.open).toBe(false);
		expect(nan.textContent).toContain('How to pay Nan');
		// Inline in the list is exactly what §17.3 forbids — it may live only inside
		// the disclosure.
		const value = [...container.querySelectorAll('span')].find(
			(el) => el.textContent === '1234567890'
		);
		expect(value).toBeTruthy();
		expect(nan.contains(value!)).toBe(true);
	});

	it('states the name check here too, not only on the settle screen', () => {
		const { container } = renderPage();

		expect(container.querySelector('[data-testid="receiving-name-check"]')?.textContent).toMatch(
			/check the name/i
		);
	});

	it('offers the group’s invite link for an unlinked member (§17.4)', () => {
		const { container } = renderPage();

		expect(container.textContent).toContain('No account yet — invite them');
		expect(
			container.querySelector('[data-testid="receiving-invite-link"]')?.getAttribute('href')
		).toBe('http://localhost/invite/tok_abc');
	});

	it('names the member in the linked-but-empty state (§17.4)', () => {
		const { container } = renderPage(
			pageData({ receiving: { m1: { state: 'no-methods' }, m2: { state: 'unlinked' } } })
		);

		expect(container.textContent).toMatch(/Nan hasn.t added a receiving method\./);
	});
});

describe('the viewer’s own row (issue #87; PLAN §17.4 case 3)', () => {
	// `viewerUserId` is `u1`, so `m3` below is the person reading the page. The
	// roster shows them whatever their balance is — nothing on this screen says
	// anyone owes them money — so the prompt PLAN §17.4 reserves for that moment
	// must not appear here. The route enforces it by not opting in; this is the
	// rendered proof.
	const OWN_ROW = {
		members: [
			{ id: 'm1', displayName: 'Nan', userId: 'u2', deactivatedAt: null, isLinked: true },
			{ id: 'm2', displayName: 'Bob', userId: null, deactivatedAt: null, isLinked: false },
			{ id: 'm3', displayName: 'Alice', userId: 'u1', deactivatedAt: null, isLinked: true }
		],
		receiving: {
			m1: BANK,
			m2: { state: 'unlinked' as const },
			m3: { state: 'no-methods' as const }
		}
	};

	it('is never asked for bank details just for being opened', () => {
		const { container } = renderPage(pageData(OWN_ROW));

		// Their own row IS rendered — and reads like anyone else's empty profile.
		expect(container.textContent).toMatch(/Alice hasn.t added a receiving method\./);
		expect(container.querySelector('[data-testid="receiving-own-empty"]')).toBeNull();
		expect(container.textContent).not.toMatch(/Add how people should pay you/);
	});
});
