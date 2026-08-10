import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('virtual:pwa-register', () => {
	throw new Error('no sw in this build');
});

describe('pwa register without a virtual SW module (PLAN §11.1)', () => {
	it('is a safe no-op when the dynamic import is unavailable', async () => {
		const mod = await import('./register.svelte');

		// browser=true ensures registerPwa reaches and catches the rejected import.
		await expect(mod.registerPwa()).resolves.toBeUndefined();
		expect(mod.pwaState.registered).toBe(false);
	});
});
