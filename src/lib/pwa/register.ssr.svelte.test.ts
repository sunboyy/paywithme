import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));

describe('pwa register during SSR (PLAN §11.1)', () => {
	it('is a safe no-op when browser === false', async () => {
		const mod = await import('./register.svelte');

		await mod.registerPwa();

		expect(mod.pwaState.registered).toBe(false);
	});
});
