import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unit tests for the reactive online/offline detector (PLAN §11 / §11.1).
// These run in the jsdom ("client") project so `window` + `navigator` exist and
// runes (`$state`) work. We drive `navigator.onLine` + the online/offline events
// and assert the browser default plus reactive flips. The SSR no-op lives in
// online.ssr.svelte.test.ts so its environment mock cannot race this file's
// browser mock during the full multi-project unit run.
//
// `$app/environment` is mocked to `browser: true` so `startOnlineWatch` actually
// wires listeners.

vi.mock('$app/environment', () => ({ browser: true }));

/** Set the (read-only-by-spec) navigator.onLine and dispatch the matching event. */
function setOnline(value: boolean) {
	Object.defineProperty(navigator, 'onLine', { value, configurable: true });
	window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

beforeEach(() => {
	vi.resetModules();
	// Start each test from a known "online" baseline.
	Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
	Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('online detector (PLAN §11)', () => {
	it('defaults to ONLINE (offline === false) before watching', async () => {
		const mod = await import('./online.svelte');
		expect(mod.network.offline).toBe(false);
	});

	it('seeds offline=true on start when navigator reports offline', async () => {
		Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
		const mod = await import('./online.svelte');
		const stop = mod.startOnlineWatch();
		expect(mod.network.offline).toBe(true);
		stop();
	});

	it('flips reactively on offline/online events', async () => {
		const mod = await import('./online.svelte');
		const stop = mod.startOnlineWatch();
		expect(mod.network.offline).toBe(false);

		setOnline(false);
		expect(mod.network.offline).toBe(true);

		setOnline(true);
		expect(mod.network.offline).toBe(false);

		stop();
	});

	it('teardown removes listeners (no further flips after stop)', async () => {
		const mod = await import('./online.svelte');
		const stop = mod.startOnlineWatch();
		stop();

		setOnline(false);
		// After teardown the flag stays at its last (online) value.
		expect(mod.network.offline).toBe(false);
	});

	it('is idempotent: a second start does not stack duplicate listeners', async () => {
		const mod = await import('./online.svelte');
		const stop1 = mod.startOnlineWatch();
		const stop2 = mod.startOnlineWatch();

		setOnline(false);
		expect(mod.network.offline).toBe(true);

		// Tearing down restores listening to a clean state for later starts.
		stop1();
		stop2();
	});
});
