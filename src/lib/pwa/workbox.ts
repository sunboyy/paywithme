// Workbox (generateSW) configuration for the service worker (PLAN §11 / §11.1).
//
// STRATEGY CHOICE: `generateSW` (Workbox), NOT `injectManifest`.
//   - 7.1 needs only a precache + a couple of declarative runtime rules; there
//     is no custom SW logic yet, so the generated SW keeps this task minimal and
//     safe. Later tasks (offline shell 7.3, install 7.4, update 7.5) extend it
//     via these declarative options (`runtimeCaching`, `navigateFallback*`) and
//     the `registerType: 'prompt'` flow — none of which require hand-written SW
//     code. If a future task needs imperative SW logic it can switch to
//     `injectManifest` then; we avoid that complexity now.
//
// §11.1 — NEVER cache authenticated responses in the SW:
//   - PRECACHE = static/build assets only (JS, CSS, icons, fonts). Handled by
//     `globPatterns` below + the SvelteKit-PWA plugin's automatic inclusion of
//     the build/ + static client assets.
//   - NAVIGATIONS are NetworkOnly: we do NOT set `navigateFallback`, so Workbox
//     installs no navigation route — navigations always hit the network and the
//     server decides auth. (The offline *shell* fallback is task 7.3; it will be
//     an auth-AGNOSTIC document, never server-rendered user data.)
//   - DATA + `/api/**` (incl `/api/auth/**`) are NetworkOnly via an explicit
//     runtimeCaching rule. No StaleWhileRevalidate on personalized content.
//   - `navigateFallbackDenylist` keeps `/api/**` out of any future navigation
//     fallback as belt-and-braces.

import type { SvelteKitPWAOptions } from '@vite-pwa/sveltekit';

// The `workbox` option type as the plugin sees it (Workbox `generateSW` config).
// Pulled through `@vite-pwa/sveltekit` because `vite-plugin-pwa` (where the type
// originates) is a transitive dep that isn't directly importable here.
type WorkboxConfig = NonNullable<SvelteKitPWAOptions['workbox']>;

export const workbox: WorkboxConfig = {
	// Precache ONLY static/build assets. No HTML documents are precached as a
	// navigation fallback in 7.1 (that auth-agnostic shell is task 7.3), so
	// navigations stay NetworkOnly and the server owns auth.
	globPatterns: ['**/*.{js,css,ico,png,svg,webp,woff,woff2}'],

	// Clean up precaches from older SW versions on activate.
	cleanupOutdatedCaches: true,

	// CRITICAL (§11.1): NO navigation fallback in 7.1, so navigations are strictly
	// NetworkOnly and the SERVER decides auth — the SW never serves a (potentially
	// stale / user-specific) precached document for a page request. The plugin
	// defaults `navigateFallback: '/'`, which would register a NavigationRoute
	// serving the precached `/` shell offline; we explicitly disable it with
	// `null`. Task 7.3 reintroduces an AUTH-AGNOSTIC offline shell as the fallback.
	navigateFallback: null,

	// `registerType: 'prompt'` (set in vite.config.ts) means we do NOT auto
	// skipWaiting here — task 7.5 wires a prompt-to-reload so auth flows don't
	// break across versions (§11.1 "SW update vs. stale client code").
	clientsClaim: false,
	skipWaiting: false,

	// Belt-and-braces: never let any (future) navigation fallback intercept the
	// API surface. Combined with the absence of `navigateFallback`, navigations
	// + API are NetworkOnly today.
	navigateFallbackDenylist: [/^\/api\//],

	// RUNTIME-STATIC CACHING DECISION (PLAN §11 "runtime cache static assets",
	// completed in task 7.2):
	//   We intentionally add NO `StaleWhileRevalidate`/`CacheFirst` runtime rule
	//   for static assets, because there are no static, non-personalized assets
	//   left to cache at runtime: everything genuinely static is already
	//   PRECACHED by `globPatterns` above —
	//     - SvelteKit `build/` JS+CSS are content-hashed and precached;
	//     - icons (static/icons/*.png) are precached by the `png` glob;
	//     - the variable Inter font is `@import`-ed into app.css, so its `woff2`
	//       files land in the hashed build output and are precached by `woff2`;
	//     - the favicon is `import`-ed (hashed) and precached.
	//   The only same-origin assets NOT precached are `robots.txt` and the
	//   generated `manifest.webmanifest` — neither benefits from a runtime cache
	//   and caching them adds risk for no gain. Per §11.1, when in doubt we stay
	//   precache-only / NetworkOnly: a runtime `StaleWhileRevalidate`/`CacheFirst`
	//   rule is reserved for a FUTURE genuinely-static, non-build-hashed,
	//   auth-free same-origin asset (none exists today). Navigations and
	//   `/api/**` MUST never get such a handler — they stay NetworkOnly below.
	runtimeCaching: [
		{
			// All API traffic — including auth (`/api/auth/**`) — is NetworkOnly.
			// Personalized / session-gated responses must never enter the SW cache.
			urlPattern: /^\/api\//,
			handler: 'NetworkOnly'
		}
	]
};
