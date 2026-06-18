// Auth-agnostic offline shell (PLAN §11 / §11.1).
//
// §11.1 requires the precached HTML shell to be AUTH-AGNOSTIC: no server-rendered
// user/session data. This route is therefore PRERENDERED to a single static doc
// at build time, so it can never carry per-user content and can be served from a
// CDN/cache safely.
//
// `prerender = true`  — emit a static HTML file (no per-request SSR, no session).
// `ssr = true`        — still server-render the markup (into the static file) so
//                       the page is meaningful with JS disabled; it just contains
//                       ZERO user data.
//
// NOTE on the service worker (§11.1, the crux): we deliberately do NOT register a
// Workbox `navigateFallback` to this page. With `generateSW`, `navigateFallback`
// installs a NavigationRoute that serves the precached fallback FROM CACHE for
// matching navigations — including ONLINE ones — which would let the SW answer a
// real navigation from cache and risk masking server-driven auth (a §11.1
// violation we cannot cleanly avoid via generateSW options). So navigations stay
// NetworkOnly (no SW navigation route at all); offline UX is handled client-side
// (the <OfflineNotice/> banner + disabled writes). This page remains a normal,
// directly-reachable static route the app can link to.
export const prerender = true;
export const ssr = true;
