// Reactive online/offline detector (PLAN §11 / §11.1).
//
// PLAN §11 requires a clear "you're offline" state that DISABLES write actions
// (no offline creation in v1). This module is the single source of truth for
// connectivity, exposed as a runes object so any component can react to it.
//
// SSR-SAFE: during SSR there is no `navigator`, and the server is by definition
// reachable for the request that produced the page — so we ASSUME ONLINE. The
// real `navigator.onLine` value + `online`/`offline` events only take effect in
// the browser, wired by {@link startOnlineWatch} from the root layout's
// browser-only `$effect`.
//
// IMPORTANT (§11.1): this is a pure UX layer. It NEVER drives caching or auth —
// auth + data stay server-driven and NetworkOnly. Disabling a submit button
// offline is a convenience; the server still re-validates and rejects writes.
// `navigator.onLine === true` only means a network interface exists, not that
// the server is reachable, so writes can still fail online — that's handled by
// the existing server-first error paths, not here.

import { browser } from '$app/environment';

/**
 * Reactive connectivity state. `offline` is the load-bearing flag consumers read
 * (e.g. to disable write submit buttons). Defaults to ONLINE so SSR and the
 * pre-`startOnlineWatch` first paint never spuriously block writes.
 */
export const network = $state({
	/** `true` when the browser reports no connectivity. SSR default: `false`. */
	offline: false
});

/** Compute the initial offline flag. SSR / no-`navigator` ⇒ online. */
function readOffline(): boolean {
	if (!browser || typeof navigator === 'undefined') return false;
	// `navigator.onLine === false` is a reliable "definitely offline" signal;
	// `true` is "maybe online" (interface up), which is the right default here.
	return navigator.onLine === false;
}

// Guard so repeated calls (HMR re-import, a stray second mount) don't stack
// duplicate listeners.
let watching = false;

/**
 * Begin watching `online`/`offline` events and seed the initial value. Browser
 * only and idempotent; a no-op during SSR. Returns a teardown fn so a Svelte
 * `$effect` can remove the listeners on unmount (and reset the guard).
 */
export function startOnlineWatch(): () => void {
	if (!browser) return () => {};

	// Seed from the current value first so the flag is correct on first paint.
	network.offline = readOffline();

	if (watching) return () => {};
	watching = true;

	const update = () => {
		network.offline = readOffline();
	};

	window.addEventListener('online', update);
	window.addEventListener('offline', update);

	return () => {
		window.removeEventListener('online', update);
		window.removeEventListener('offline', update);
		watching = false;
	};
}
