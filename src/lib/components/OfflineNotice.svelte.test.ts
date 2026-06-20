import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { network } from '$lib/pwa/online.svelte';
import OfflineNotice from './OfflineNotice.svelte';

// Client (jsdom) a11y test for the transient OfflineNotice (task 8.3; PLAN §11).
//
// Transient status feedback must be announced to AT WITHOUT stealing focus — the
// established pattern in this app is a `role="status"` + `aria-live="polite"`
// live region (shared by the offline / update prompts). This guards that the
// banner keeps that contract, conveys state with an icon + TEXT (not color alone),
// and marks the icon decorative.

afterEach(() => {
	cleanup();
	network.offline = false;
});

describe('OfflineNotice a11y', () => {
	it('renders nothing while online', () => {
		network.offline = false;
		const { queryByTestId } = render(OfflineNotice);
		expect(queryByTestId('offline-notice')).toBeNull();
	});

	it('announces offline via a polite status live region with text (not color alone)', () => {
		network.offline = true;
		const { getByTestId } = render(OfflineNotice);
		const region = getByTestId('offline-notice');
		expect(region.getAttribute('role')).toBe('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		// The state is conveyed as real text, not by color/icon alone.
		expect(region.textContent?.trim().length).toBeGreaterThan(0);
		// The icon is decorative (the text carries the meaning).
		const icon = region.querySelector('svg');
		expect(icon?.getAttribute('aria-hidden')).toBe('true');
	});
});
