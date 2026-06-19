import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import UsersIcon from '@lucide/svelte/icons/users';
import EmptyState from './EmptyState.svelte';

// Client (jsdom) tests for the shared EmptyState (task 8.1; PLAN §14.8).
//
// EmptyState is presentation only: it always renders the title + description as
// REAL text (never an icon alone — an a11y basic), renders a decorative icon
// only when one is passed (and marks it aria-hidden), and renders whatever the
// caller puts in the `action` snippet (the create / clear-filter CTA, a real
// focusable link in the routes).

describe('EmptyState', () => {
	it('renders the title and description as text', () => {
		const { getByText, container } = render(EmptyState, {
			props: {
				title: 'No groups yet',
				description: 'Create a group to start splitting.'
			}
		});
		expect(getByText('No groups yet')).toBeTruthy();
		expect(getByText('Create a group to start splitting.')).toBeTruthy();
		// The card surface is marked for testing/styling.
		expect(container.querySelector('[data-testid="empty-state"]')).not.toBeNull();
	});

	it('renders no icon by default and no action region', () => {
		const { container } = render(EmptyState, {
			props: { title: 'Empty', description: 'Nothing here.' }
		});
		expect(container.querySelector('svg')).toBeNull();
		expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
	});

	it('renders a decorative icon (aria-hidden) when an icon is passed', () => {
		const { container } = render(EmptyState, {
			props: { title: 'Empty', description: 'Nothing here.', icon: UsersIcon }
		});
		const decorative = container.querySelector('[aria-hidden="true"]');
		expect(decorative).not.toBeNull();
		// The lucide icon renders an <svg> inside the decorative wrapper.
		expect(decorative?.querySelector('svg')).not.toBeNull();
	});

	it('renders the action snippet (e.g. a CTA link)', () => {
		const action = createRawSnippet(() => ({
			render: () => `<a href="/groups/new" data-testid="cta">Create your first group</a>`
		}));
		const { getByTestId } = render(EmptyState, {
			props: {
				title: 'No groups yet',
				description: 'Create a group.',
				action
			}
		});
		const cta = getByTestId('cta');
		expect(cta).toBeTruthy();
		expect(cta.getAttribute('href')).toBe('/groups/new');
		expect(cta.textContent).toBe('Create your first group');
	});
});
