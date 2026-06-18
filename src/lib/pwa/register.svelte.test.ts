import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for the SW registration extension point (PLAN §11 / §11.1) that
// task 7.2 adds on top of 7.1's inert config. We mock the build-time virtual
// module + `$app/environment` so we can assert:
//   - `registerType: 'prompt'` semantics: registration does NOT auto-reload; a
//     waiting update only flips `pwaState.needRefresh`, and the reload happens
//     ONLY when `applyUpdate()` is called.
//   - the reactive `pwaState` seam that 7.3 / 7.4 / 7.5 build on.
//   - registration is a safe no-op when no SW is available (dynamic import
//     rejects) and during SSR (`browser === false`).

const registerSW = vi.fn();
let lastOptions: Record<string, () => void> = {};

vi.mock('virtual:pwa-register', () => ({
	registerSW: (opts: Record<string, () => void>) => {
		lastOptions = opts;
		return registerSW;
	}
}));

// Default: simulate the browser. Individual tests can re-mock for SSR.
vi.mock('$app/environment', () => ({ browser: true }));

beforeEach(() => {
	vi.resetModules();
	registerSW.mockReset();
	lastOptions = {};
});

describe('pwa register (PLAN §11.1 — prompt-to-reload, never auto-reload)', () => {
	it('exposes a reactive pwaState seam for tasks 7.3/7.4/7.5', async () => {
		const mod = await import('./register.svelte');
		expect(mod.pwaState).toMatchObject({
			needRefresh: false,
			offlineReady: false,
			registered: false
		});
		expect(typeof mod.registerPwa).toBe('function');
		expect(typeof mod.applyUpdate).toBe('function');
	});

	it('registers without auto-reloading and wires prompt-flow callbacks', async () => {
		const mod = await import('./register.svelte');
		await mod.registerPwa();

		// `immediate: false` => the SW does not seize control / reload on its own.
		expect((lastOptions as unknown as { immediate?: boolean }).immediate).toBe(false);

		// A waiting update only flips state — it must NOT reload here.
		lastOptions.onNeedRefresh?.();
		expect(mod.pwaState.needRefresh).toBe(true);
		expect(registerSW).not.toHaveBeenCalled();

		lastOptions.onOfflineReady?.();
		expect(mod.pwaState.offlineReady).toBe(true);

		lastOptions.onRegisteredSW?.();
		expect(mod.pwaState.registered).toBe(true);
	});

	it('only reloads when applyUpdate() is explicitly called', async () => {
		const mod = await import('./register.svelte');
		await mod.registerPwa();
		expect(registerSW).not.toHaveBeenCalled();

		await mod.applyUpdate();
		expect(registerSW).toHaveBeenCalledTimes(1);
	});

	it('registers at most once even if called repeatedly', async () => {
		const mod = await import('./register.svelte');
		await mod.registerPwa();
		await mod.registerPwa();
		await mod.applyUpdate();
		// The single retained updater is invoked once; double-register guarded.
		expect(registerSW).toHaveBeenCalledTimes(1);
	});

	it('applyUpdate() is a no-op before any SW is registered', async () => {
		const mod = await import('./register.svelte');
		await expect(mod.applyUpdate()).resolves.toBeUndefined();
		expect(registerSW).not.toHaveBeenCalled();
	});

	it('is a safe no-op during SSR (browser === false)', async () => {
		vi.doMock('$app/environment', () => ({ browser: false }));
		vi.resetModules();
		const mod = await import('./register.svelte');
		await mod.registerPwa();
		// No registration happened; state untouched.
		expect(mod.pwaState.registered).toBe(false);
	});

	it('is a safe no-op when the virtual SW module is unavailable (dev/preview)', async () => {
		vi.doMock('virtual:pwa-register', () => {
			throw new Error('no sw in this build');
		});
		vi.resetModules();
		const mod = await import('./register.svelte');
		// Must not throw even though the dynamic import rejects.
		await expect(mod.registerPwa()).resolves.toBeUndefined();
		expect(mod.pwaState.registered).toBe(false);
	});
});
