import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import NotRecordedYetTray, { type TrayCapture } from './NotRecordedYetTray.svelte';

// SERVER-RENDER tests for the "Not recorded yet" tray (issue #50; PLAN §7.7, §10).
//
// WHY SSR AND NOT THE USUAL jsdom MOUNT. §10 says the destructive confirmation is
// a PROGRESSIVE-ENHANCEMENT layer: "without JS the underlying real form action
// still works". `ConfirmSubmit` implements that as a pre-mount `{:else}` branch
// holding a plain `type="submit"` button — and testing-library's client render
// flips `onMount` immediately, so the no-JS branch is exactly the thing a mount
// test CANNOT observe (its own suite says so). Rendering through `svelte/server`
// produces the markup a browser with JavaScript disabled actually receives, which
// is the only place that claim can be checked.
//
// The jsdom half — the Alert Dialog gating the submit once hydrated — is covered
// by the page's `mount.svelte.test.ts`. Between them both branches are pinned.

function tray(overrides: Partial<TrayCapture> = {}): TrayCapture {
	return {
		id: 'cap-1',
		note: 'dinner at the night market',
		authorName: 'Sur',
		amountFormatted: '฿1,200.00',
		capturedFor: '2026-08-01',
		...overrides
	};
}

function ssr(captures: TrayCapture[]): string {
	return render(NotRecordedYetTray, {
		props: { captures, discardAction: '?/discard', enhance: () => {} }
	}).body;
}

describe('"Not recorded yet" tray — served WITHOUT JavaScript', () => {
	it('discard is a real form action with a plain submit button (no dialog gate)', () => {
		const body = ssr([tray()]);

		// The mechanism, present before a single byte of JS has run.
		expect(body).toContain('method="POST"');
		expect(body).toContain('action="?/discard"');
		expect(body).toContain('name="captureId"');
		expect(body).toContain('value="cap-1"');
		expect(body).toContain('type="submit"');

		// …and the confirmation is NOT part of it: the dialog is the guard, so a
		// browser that never hydrates must not be left with an inert trigger button
		// as its only control.
		expect(body).not.toContain('data-slot="alert-dialog-trigger"');
	});

	it('still attributes every note to its author', () => {
		const body = ssr([tray(), tray({ id: 'cap-2', note: 'that taxi', authorName: 'Ada' })]);
		expect(body).toContain('Sur');
		expect(body).toContain('Ada');
		expect(body).toContain('that taxi');
	});

	it('escapes member-authored text in the server-rendered markup', () => {
		const body = ssr([tray({ note: '<img src=x onerror=alert(1)>' })]);
		expect(body).toContain('&lt;img');
		expect(body).not.toContain('<img');
	});

	it('renders nothing at all when nothing is open', () => {
		expect(ssr([])).not.toContain('Not recorded yet');
	});
});

// The §7.7 naming rule ("no user-facing string says Capture") is asserted on the
// page's rendered TEXT in `mount.svelte.test.ts`, not here: raw SSR markup also
// carries wire names like the `captureId` form field, which no user ever reads.
