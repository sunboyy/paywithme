import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Build-OUTPUT assertions for the GENERATED service worker (PLAN §11.1). These
// inspect `.svelte-kit/output/client/sw.js` to prove the §11.1 invariants
// survive the Workbox `generateSW` codegen — complementing the config-level
// assertions in `manifest.test.ts` (which test the objects we own).
//
// RESILIENCE: the fast gate (`scripts/gate.sh`) does NOT build, so the SW won't
// exist there — we SKIP the suite when it's absent instead of failing. After a
// `pnpm build` the suite runs and enforces the invariants. We also match only
// STABLE Workbox API tokens (`registerRoute`, `NavigationRoute`, `NetworkOnly`,
// `precacheAndRoute`) and the literal route regex we configured — not minified
// identifiers — so the test isn't brittle against Workbox internals.

const swPath = fileURLToPath(new URL('../../../.svelte-kit/output/client/sw.js', import.meta.url));
const swExists = existsSync(swPath);
const sw = swExists ? readFileSync(swPath, 'utf8') : '';

// `describe.skipIf` keeps the fast gate green pre-build while still enforcing the
// invariants whenever a build artifact is present.
describe.skipIf(!swExists)('generated sw.js (PLAN §11.1 invariants)', () => {
	it('registers NO navigation route (navigations stay NetworkOnly)', () => {
		expect(sw).not.toContain('NavigationRoute');
	});

	it('routes /api/** NetworkOnly and registers exactly one route', () => {
		// The literal pattern + handler we configured in workbox.ts.
		expect(sw).toContain('/^\\/api\\//');
		expect(sw).toContain('NetworkOnly');
		const routeCount = (sw.match(/registerRoute/g) ?? []).length;
		expect(routeCount).toBe(1);
	});

	it('never adds StaleWhileRevalidate / CacheFirst (no personalized caching)', () => {
		expect(sw).not.toContain('StaleWhileRevalidate');
		// `CacheFirst` as a whole token (avoid matching unrelated substrings).
		expect(sw).not.toMatch(/\bCacheFirst\b/);
	});

	it('precaches assets but never an HTML document', () => {
		expect(sw).toContain('precacheAndRoute');
		// No `.html` entry in the precache manifest.
		expect(sw).not.toMatch(/"[^"]*\.html"/);
	});

	it('does NOT auto-skipWaiting; exposes a SKIP_WAITING message hook for 7.5', () => {
		// Prompt-to-reload (§11.1): skipWaiting runs only on an explicit message,
		// never unconditionally, and there is no clientsClaim().
		expect(sw).toContain('SKIP_WAITING');
		expect(sw).not.toContain('clientsClaim()');
	});
});
