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

	it('precaches assets and ONLY the auth-agnostic /offline HTML shell (§11.1)', () => {
		expect(sw).toContain('precacheAndRoute');

		// The plugin auto-includes the PRERENDERED `/offline` route in the precache
		// manifest (URL `"offline"` + its `"offline/__data.json"`). §11.1 explicitly
		// permits this: the precached HTML shell must be AUTH-AGNOSTIC, and `/offline`
		// is prerendered with no session (its `__data.json` resolves `user: null`).
		expect(sw).toMatch(/url:"offline"/);

		// No OTHER prerendered/SSR page document is precached. SvelteKit emits server
		// routes WITHOUT a file extension in the precache URL, so we can't key off
		// `.html`; instead assert the only document-like (non-asset, non-manifest,
		// non-offline) precache URLs don't exist. Real authed pages would appear as
		// e.g. `url:"groups"` / `url:"settings"` here — they must not.
		const precacheUrls = [...sw.matchAll(/url:"([^"]*)"/g)].map((m) => m[1]);
		const documentLike = precacheUrls.filter(
			(u) =>
				u !== 'offline' &&
				u !== 'offline/__data.json' &&
				u !== 'manifest.webmanifest' &&
				!/\.(js|css|ico|png|svg|webp|woff2?|json|webmanifest)$/.test(u)
		);
		expect(documentLike).toEqual([]);
	});

	it('serves NO navigation route — the offline shell is never used for ONLINE navs (§11.1)', () => {
		// 7.3 decision (§11.1, the crux): the prerendered `/offline` shell is precached
		// (auth-agnostic) but we deliberately did NOT wire a Workbox `navigateFallback`.
		// With generateSW, `navigateFallback` installs a NavigationRoute that serves the
		// precached fallback FROM CACHE for matching navigations — INCLUDING online ones
		// — which could mask server-driven auth. With no NavigationRoute, navigations
		// stay NetworkOnly (the server always owns auth) and the precached shell can
		// only ever be reached by an explicit online navigation, never substituted for
		// a real page. The offline UX is client-side (<OfflineNotice/> + disabled writes).
		expect(sw).not.toContain('NavigationRoute');
		expect(sw).not.toContain('navigateFallback');
	});

	it('does NOT auto-skipWaiting; exposes a SKIP_WAITING message hook for 7.5', () => {
		// Prompt-to-reload (§11.1): skipWaiting runs only on an explicit message,
		// never unconditionally, and there is no clientsClaim().
		expect(sw).toContain('SKIP_WAITING');
		expect(sw).not.toContain('clientsClaim()');
	});
});
