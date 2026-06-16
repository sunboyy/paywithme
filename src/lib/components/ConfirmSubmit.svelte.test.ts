import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import ConfirmSubmit from './ConfirmSubmit.svelte';

// Client test for `ConfirmSubmit` (PLAN §10 destructive-action confirmation).
//
// NOTE on the no-JS fallback: the `{:else}` (pre-mount) branch renders a plain
// `type="submit"` button so the action works WITHOUT JS. testing-library's
// client render flips `onMount`'s `mounted` flag immediately, so it lands on the
// dialog branch — the pre-mount fallback can't be observed directly here (it's
// exercised in real SSR by the route, and the swap logic is a single `mounted`
// flag). This test asserts the post-mount wiring that's reliably observable in
// jsdom: the REAL form (method/action/hidden field), the AlertDialog trigger
// button, and that `disabled` propagates to the trigger.

const noopEnhance = () => {};

const baseProps = {
	action: '?/removeMember',
	enhance: noopEnhance,
	hiddenName: 'memberId',
	hiddenValue: 'm1',
	triggerLabel: 'Remove Alex',
	title: 'Remove Alex?',
	description: 'Alex will be removed.',
	confirmLabel: 'Remove'
};

describe('ConfirmSubmit', () => {
	it('renders a real form posting to the action with the hidden field', () => {
		const { container } = render(ConfirmSubmit, { props: baseProps });
		const form = container.querySelector('form');
		expect(form).not.toBeNull();
		expect(form?.getAttribute('method')?.toUpperCase()).toBe('POST');
		expect(form?.getAttribute('action')).toBe('?/removeMember');
		const hidden = form?.querySelector('input[type="hidden"]');
		expect(hidden?.getAttribute('name')).toBe('memberId');
		expect(hidden?.getAttribute('value')).toBe('m1');
	});

	it('renders an interactive trigger labelled by the destructive action', () => {
		const { container } = render(ConfirmSubmit, { props: baseProps });
		// The trigger button (post-mount) carries the destructive trigger label.
		const trigger = container.querySelector('[data-slot="alert-dialog-trigger"]');
		expect(trigger).not.toBeNull();
		expect(trigger?.textContent).toContain('Remove Alex');
	});

	it('disables the trigger when `disabled` is set', () => {
		const { container } = render(ConfirmSubmit, { props: { ...baseProps, disabled: true } });
		const button = container.querySelector('button');
		expect(button).not.toBeNull();
		expect(button?.disabled).toBe(true);
	});
});
