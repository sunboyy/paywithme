import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { defaults } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { buildTransactionSchema } from '$lib/schemas/transaction';
import Page from './+page.svelte';
import type { PageData } from './$types';

// Regression test for the add-transaction page (PLAN §7, §10).
//
// The bug: `TransactionForm`'s sync `$effect` read `$formData` (subscribing to the
// superForm store) AND wrote several `$formData.*` fields UNCONDITIONALLY. superForm
// notifies subscribers on every write, so the effect re-triggered itself forever —
// the page froze on mount with `effect_update_depth_exceeded`. The fast gate missed
// it because no test rendered the form in a reactive runtime (the e2e suite never
// opens this page). This test mounts the real page (which builds the real superForm)
// and asserts it renders WITHOUT throwing — it fails on the unconditional-write
// version and passes once every write is guarded by an equality check (idempotent).

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, k) => params[k] ?? `[${k}]`) : path
}));

const schema = buildTransactionSchema({
	settlementCurrency: 'THB',
	memberIds: ['m1', 'm2']
});

/** Page data mirroring what `new/+page.server.ts` (+ the root layout) provides. */
function pageData(): PageData {
	return {
		user: { name: 'Alex', email: 'alex@example.com' },
		viewerMemberId: 'm1',
		group: { id: 'g1', name: 'Trip', settlementCurrency: 'THB' },
		members: [
			{ id: 'm1', displayName: 'Alex', isLinked: true },
			{ id: 'm2', displayName: 'Sam', isLinked: false }
		],
		categories: {
			spending: [{ id: 'spending-food-drink', name: 'Food & Drink', icon: 'utensils' }],
			transfer: [{ id: 'transfer-cash', name: 'Cash', icon: 'banknote' }]
		},
		currency: { code: 'THB', symbol: '฿', exponent: 2 },
		currencies: [
			{ code: 'THB', symbol: '฿', exponent: 2, name: 'Thai Baht' },
			{ code: 'JPY', symbol: '¥', exponent: 0, name: 'Japanese Yen' }
		],
		form: defaults(zod4(schema))
	};
}

afterEach(cleanup);

describe('add-transaction page mounts without an effect loop', () => {
	it('renders the form without throwing effect_update_depth_exceeded', () => {
		// A mount-time reactive loop throws synchronously during Svelte's flush, so a
		// successful render is the assertion. (Pre-fix this render threw.)
		expect(() => render(Page, { props: { data: pageData() } })).not.toThrow();
	});

	it('shows the transaction form fields', () => {
		const { container } = render(Page, { props: { data: pageData() } });
		// The real <form> body mounted (proving the form rendered past the effect).
		expect(container.querySelector('form')).not.toBeNull();
		// "Add transaction" appears (card title + submit button).
		expect(container.textContent).toContain('Add transaction');
		// Unique form-section legends render, confirming the form body mounted.
		expect(container.textContent).toContain('Paid by');
		expect(container.textContent).toContain('Split between');
	});
});
