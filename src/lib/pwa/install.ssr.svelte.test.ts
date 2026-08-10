import { describe, expect, it, vi } from 'vitest';

// Keep the SSR environment fixed for this entire test module. In particular,
// do not swap this mock with the browser=true mock used by install.svelte.test.ts:
// repeated doMock/resetModules calls can race dynamic imports when Vitest runs
// the client and server projects concurrently.
vi.mock('$app/environment', () => ({ browser: false }));

describe('install module during SSR (PLAN §11)', () => {
	it('is a safe no-op when browser === false', async () => {
		const mod = await import('./install.svelte');
		const stop = mod.startInstallWatch();

		window.dispatchEvent(new Event('beforeinstallprompt'));
		expect(mod.install.available).toBe(false);
		expect(await mod.promptInstall()).toBeNull();
		expect(mod.isIosInstallable()).toBe(false);
		expect(typeof stop).toBe('function');
		stop();
	});
});
