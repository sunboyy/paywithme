import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import MobileActionBar from './MobileActionBar.svelte';

// Client (jsdom) test for the shared MobileActionBar (task 8.2; PLAN #28, §10).
//
// MobileActionBar is presentation/layout only: it wraps a screen's primary
// action(s) in a sticky, safe-area-aware container so the real submit stays
// thumb-reachable on phones. It does NOT own the form or the button — the caller
// passes the REAL submit (inside the real <form>) via the default slot, so
// progressive enhancement is preserved. These tests assert it renders whatever is
// slotted into it (the primary action survives the wrapper) and exposes its
// testing hook. Queries are scoped to each render's `container` (no global
// auto-cleanup is configured) so repeated renders don't collide.

describe('MobileActionBar', () => {
	it('renders the slotted primary action', () => {
		const children = createRawSnippet(() => ({
			render: () => `<button type="submit" data-testid="primary">Add transaction</button>`
		}));
		const { container } = render(MobileActionBar, { props: { children } });
		const action = container.querySelector('[data-testid="primary"]');
		expect(action).not.toBeNull();
		expect(action?.getAttribute('type')).toBe('submit');
		expect(action?.textContent).toBe('Add transaction');
	});

	it('wraps the action in its sticky bar surface', () => {
		const children = createRawSnippet(() => ({
			render: () => `<button type="submit" data-testid="primary">Save</button>`
		}));
		const { container } = render(MobileActionBar, { props: { children } });
		const bar = container.querySelector('[data-testid="mobile-action-bar"]');
		expect(bar).not.toBeNull();
		// The bar is sticky-anchored to the bottom on mobile (reachability).
		expect(bar?.className).toContain('sticky');
		expect(bar?.className).toContain('bottom-0');
		// The slotted action lives inside the bar surface (the real submit is
		// preserved within the wrapper, keeping progressive enhancement intact).
		expect(bar?.querySelector('[data-testid="primary"]')).not.toBeNull();
	});

	it('applies caller-provided classes to the content wrapper', () => {
		const children = createRawSnippet(() => ({
			render: () => `<button type="submit" data-testid="primary">Save</button>`
		}));
		const { container } = render(MobileActionBar, {
			props: { children, class: 'flex-row-test' }
		});
		const bar = container.querySelector('[data-testid="mobile-action-bar"]');
		expect(bar?.querySelector('.flex-row-test')).not.toBeNull();
	});
});
