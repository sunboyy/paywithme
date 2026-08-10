import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));

afterEach(() => {
	Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('online detector during SSR (PLAN §11)', () => {
	it('is a safe no-op when browser === false', async () => {
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
