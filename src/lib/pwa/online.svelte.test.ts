import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unit tests for the reactive online/offline detector (PLAN §11 / §11.1).
// These run in the jsdom ("client") project so `window` + `navigator` exist and
// runes (`$state`) work. We drive `navigator.onLine` + the online/offline events
// and assert the SSR-safe default plus reactive flips.
//
// `$app/environment` is mocked to `browser: true` so `startOnlineWatch` actually
// wires listeners; one test re-mocks it to `false` to prove the SSR no-op.

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

	it('is a safe no-op during SSR (browser === false)', async () => {
		vi.doMock('$app/environment', () => ({ browser: false }));
		vi.resetModules();
		const mod = await import('./online.svelte');
		const stop = mod.startOnlineWatch();
		// Even with navigator.onLine === false, SSR mode must not flip the flag.
		Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
		window.dispatchEvent(new Event('offline'));
		expect(mod.network.offline).toBe(false);
		expect(typeof stop).toBe('function');
		stop();
	});
});
