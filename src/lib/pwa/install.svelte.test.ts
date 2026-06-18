import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unit tests for the "Add to home screen" install module (PLAN §11). These run
// in the jsdom ("client") project so `window` + `navigator` exist and runes
// (`$state`) work. We synthesize Chromium's `beforeinstallprompt` (with a
// `prompt()` + `userChoice`) and the `appinstalled` event and assert the reactive
// flips, single-use semantics, SSR no-op, and idempotent start + teardown.
//
// `$app/environment` is mocked to `browser: true` so `startInstallWatch` wires
// listeners; one test re-mocks it to `false` to prove the SSR no-op.

vi.mock('$app/environment', () => ({ browser: true }));

type Choice = 'accepted' | 'dismissed';

/**
 * Build a fake `beforeinstallprompt` event with a spy `prompt()` and a
 * `userChoice` resolving to the given outcome. `preventDefault` is a spy so we
 * can assert the module suppressed the browser's default mini-infobar.
 */
function makeBip(outcome: Choice = 'accepted') {
	const event = new Event('beforeinstallprompt');
	const prompt = vi.fn().mockResolvedValue(undefined);
	const preventDefault = vi.fn();
	Object.assign(event, {
		prompt,
		userChoice: Promise.resolve({ outcome, platform: 'web' }),
		preventDefault
	});
	return event as Event & { prompt: typeof prompt; preventDefault: typeof preventDefault };
}

beforeEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	// Re-assert the browser mock every test: the SSR test below uses `vi.doMock`
	// to flip it to `false`, which persists across `resetModules` until restored.
	vi.doMock('$app/environment', () => ({ browser: true }));
	// Default UA / standalone state: a generic non-iOS, non-standalone browser.
	Object.defineProperty(navigator, 'userAgent', {
		value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
		configurable: true
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('install module (PLAN §11)', () => {
	it('is not available before any beforeinstallprompt fires', async () => {
		const mod = await import('./install.svelte');
		expect(mod.install.available).toBe(false);
		expect(mod.install.installed).toBe(false);
	});

	it('captures beforeinstallprompt: prevents default and flips available', async () => {
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();

		const bip = makeBip();
		window.dispatchEvent(bip);

		expect(bip.preventDefault).toHaveBeenCalledOnce();
		expect(mod.install.available).toBe(true);
		stop();
	});

	it('promptInstall() calls prompt(), resolves the outcome, and clears availability', async () => {
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();

		const bip = makeBip('accepted');
		window.dispatchEvent(bip);
		expect(mod.install.available).toBe(true);

		const outcome = await mod.promptInstall();

		expect(bip.prompt).toHaveBeenCalledOnce();
		expect(outcome).toBe('accepted');
		// Available is cleared as soon as the (single-use) prompt is consumed.
		expect(mod.install.available).toBe(false);
		stop();
	});

	it('the deferred prompt is single-use: a second promptInstall() is a no-op', async () => {
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();

		const bip = makeBip('dismissed');
		window.dispatchEvent(bip);

		await mod.promptInstall();
		expect(bip.prompt).toHaveBeenCalledOnce();

		// Second call: nothing held, returns null, prompt() not called again.
		const again = await mod.promptInstall();
		expect(again).toBeNull();
		expect(bip.prompt).toHaveBeenCalledOnce();
		stop();
	});

	it('promptInstall() returns null when nothing is held', async () => {
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();
		expect(await mod.promptInstall()).toBeNull();
		stop();
	});

	it('appinstalled flips installed true and clears availability', async () => {
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();

		window.dispatchEvent(makeBip());
		expect(mod.install.available).toBe(true);

		window.dispatchEvent(new Event('appinstalled'));
		expect(mod.install.installed).toBe(true);
		expect(mod.install.available).toBe(false);

		// A subsequent prompt held after install is suppressed (already installed).
		window.dispatchEvent(makeBip());
		expect(mod.install.available).toBe(false);
		stop();
	});

	it('is a safe no-op during SSR (browser === false)', async () => {
		vi.doMock('$app/environment', () => ({ browser: false }));
		vi.resetModules();
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();

		window.dispatchEvent(makeBip());
		expect(mod.install.available).toBe(false);
		expect(await mod.promptInstall()).toBeNull();
		expect(mod.isIosInstallable()).toBe(false);
		expect(typeof stop).toBe('function');
		stop();
	});

	it('teardown removes listeners (no further flips after stop)', async () => {
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();
		stop();

		window.dispatchEvent(makeBip());
		// After teardown the captured event is ignored.
		expect(mod.install.available).toBe(false);
	});

	it('is idempotent: a second start does not stack duplicate listeners', async () => {
		const mod = await import('./install.svelte');
		const stop1 = mod.startInstallWatch();
		const stop2 = mod.startInstallWatch();

		window.dispatchEvent(makeBip());
		expect(mod.install.available).toBe(true);

		// First teardown alone removes the (single) listener set.
		stop1();
		window.dispatchEvent(new Event('appinstalled'));
		// installed still flips? No — listener was removed by stop1.
		expect(mod.install.installed).toBe(false);
		stop2();
	});

	it('detects standalone mode and marks installed on start (no install offered)', async () => {
		vi.stubGlobal('matchMedia', (query: string) => ({
			matches: query.includes('standalone'),
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false
		}));
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();

		expect(mod.install.installed).toBe(true);
		expect(mod.install.available).toBe(false);

		// Even a captured prompt must not offer install while standalone.
		window.dispatchEvent(makeBip());
		expect(mod.install.available).toBe(false);
		stop();
	});

	describe('isIosInstallable()', () => {
		it('is true for iOS Safari not in standalone mode', async () => {
			Object.defineProperty(navigator, 'userAgent', {
				value:
					'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
				configurable: true
			});
			const mod = await import('./install.svelte');
			expect(mod.isIosInstallable()).toBe(true);
		});

		it('is false in an iOS in-app webview (e.g. Chrome iOS / CriOS)', async () => {
			Object.defineProperty(navigator, 'userAgent', {
				value:
					'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120 Mobile/15E148 Safari/604.1',
				configurable: true
			});
			const mod = await import('./install.svelte');
			expect(mod.isIosInstallable()).toBe(false);
		});

		it('is false on a non-iOS browser', async () => {
			const mod = await import('./install.svelte');
			expect(mod.isIosInstallable()).toBe(false);
		});
	});
});
