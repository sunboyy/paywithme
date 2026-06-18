// Client-only service-worker registration + the cross-task extension point
// (PLAN §11 / §11.1). Task 7.2 *activates* the SW that task 7.1 generated but
// left inert; it does NOT build any update / install / offline UI — those are
// tasks 7.5 / 7.4 / 7.3, which read the reactive state and call the actions
// exported here.
//
// WHY a `.svelte.ts` runes module:
//   The plugin's `registerType: 'prompt'` (vite.config.ts) means the SW must NOT
//   auto-reload when a new version is waiting. Instead we surface that fact as
//   reactive state (`pwaState`) and hand the consumer an explicit
//   `applyUpdate()` action. 7.5's prompt-to-reload UI binds to
//   `pwaState.needRefresh` and calls `applyUpdate()` on confirm; 7.3's offline
//   shell can read `pwaState.offlineReady`. This keeps 7.2 to registration +
//   the §11.1 caching contract while leaving a stable seam for later tasks.
//
// SAFETY:
//   - This module is imported only behind `browser` (see `+layout.svelte`), so
//     it never runs during SSR.
//   - It imports `virtual:pwa-register` *dynamically* inside `registerPwa()`.
//     `devOptions.enabled: false` keeps the SW out of the Vite dev server
//     (`pnpm dev`) ONLY. Under a production build + preview
//     (`pnpm build && pnpm preview`, which the Playwright e2e uses) `sw.js` IS
//     emitted, `virtual:pwa-register` IS bundled, and the SW DOES register in
//     the browser during the e2e session. That is safe NOT because the SW is
//     absent but because it is NetworkOnly for navigations and `/api/**`, does
//     not claim already-open clients (`clientsClaim: false`), and does not
//     auto-activate (`registerType: 'prompt'`) — so it can never serve a stale
//     or authenticated response (PLAN §11.1). The dynamic-import try/catch
//     no-op still covers the genuine dev-server case where the virtual module
//     is absent.

import { browser } from '$app/environment';

/**
 * Reactive PWA state — the public extension point for tasks 7.3 / 7.4 / 7.5.
 *
 * - `needRefresh`  — a new SW version is installed and waiting. 7.5 renders a
 *   prompt-to-reload from this and calls {@link applyUpdate} on confirm. We do
 *   NOT auto-reload (PLAN §11.1: "prompt-to-reload … so auth flows don't break
 *   across versions").
 * - `offlineReady` — the SW has finished precaching and the app can work with
 *   its static shell offline. 7.3's offline shell can surface this.
 * - `registered`   — the SW registration succeeded (best-effort signal).
 */
export const pwaState = $state({
	needRefresh: false,
	offlineReady: false,
	registered: false
});

// Holds the `registerSW`-returned updater so {@link applyUpdate} can trigger the
// controlled reload. Null until (and unless) registration succeeds.
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = null;

/**
 * Apply a waiting SW update and reload under its control. No-op until a SW is
 * actually waiting (`pwaState.needRefresh`). 7.5 wires this to its prompt's
 * confirm action; calling it is the ONLY path that reloads the page — nothing
 * here reloads automatically.
 */
export async function applyUpdate(): Promise<void> {
	if (updateServiceWorker) {
		await updateServiceWorker(true);
	}
}

// Guard against double registration (e.g. HMR re-import or a stray second call).
let started = false;

/**
 * Register the generated service worker, wiring the prompt-flow callbacks into
 * {@link pwaState}. Safe to call unconditionally: it is a no-op during SSR and
 * in the Vite dev server (`pnpm dev`, where `devOptions.enabled: false` means no
 * SW is emitted), because the `virtual:pwa-register` import is dynamic and its
 * failure is swallowed. Under a prod build + preview (incl. the Playwright e2e)
 * the SW IS emitted and DOES register — harmlessly, per the §11.1 note above.
 */
export async function registerPwa(): Promise<void> {
	if (!browser || started) return;
	started = true;

	try {
		// Dynamic import: `virtual:pwa-register` only resolves in builds where the
		// SW is emitted. In the Vite dev server (devOptions disabled) the import
		// rejects and we no-op. Under build+preview/e2e it resolves and the SW
		// registers — safe because it's NetworkOnly for navigations + `/api/**`
		// with `clientsClaim: false` + `registerType: 'prompt'` (§11.1).
		const { registerSW } = await import('virtual:pwa-register');

		updateServiceWorker = registerSW({
			// `registerType: 'prompt'` ⇒ do NOT auto-reload; just record that an
			// update is waiting and let 7.5's UI drive the reload via applyUpdate().
			immediate: false,
			onNeedRefresh() {
				pwaState.needRefresh = true;
			},
			onOfflineReady() {
				pwaState.offlineReady = true;
			},
			onRegisteredSW() {
				pwaState.registered = true;
			},
			onRegisterError() {
				// Registration failure must not break the app; auth + data are
				// server-driven (§11.1) and work without the SW.
			}
		});
	} catch {
		// No SW in this build (dev/preview) or registration unsupported: no-op.
	}
}
