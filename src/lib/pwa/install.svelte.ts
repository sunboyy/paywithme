// "Add to home screen" install-prompt handling (PLAN §11: "'Add to home screen'
// install prompt handling"). This is pure CLIENT UX around the browser's
// `beforeinstallprompt` event — it does NOT touch the §11.1 caching contract
// (the SW/manifest are owned by 7.1 and stay as-is). The manifest from 7.1
// already satisfies the installability prerequisites; this module only decides
// WHEN to offer the install affordance and drives the native prompt.
//
// WHY a `.svelte.ts` runes module (mirrors `online.svelte.ts`):
//   The install opportunity is event-driven and transient — Chromium fires
//   `beforeinstallprompt` only when the app is installable AND not yet
//   installed, and the deferred event is single-use. We capture that event,
//   expose its availability as reactive state, and hand the consumer an explicit
//   `promptInstall()` action. The root layout wires `startInstallWatch()` in a
//   browser-only `$effect` (with teardown), exactly like the online watcher, and
//   `<InstallPrompt/>` reads `install.available` to show a small affordance.
//
// SSR-SAFE: during SSR there is no `window`, so we ASSUME NOT-INSTALLABLE
// (`available = false`) and `startInstallWatch()` is a no-op. The real state is
// only ever set in the browser from the captured event.
//
// iOS NOTE: `beforeinstallprompt` does NOT fire on iOS Safari (no programmatic
// install API). So `install.available` is never set there and the native
// affordance never shows. iOS users install via the Share menu → "Add to Home
// Screen"; `<InstallPrompt/>` surfaces a tiny, dismissible hint for that case
// (and only when NOT already in standalone mode). This module stays iOS-inert.

import { browser } from '$app/environment';

/**
 * The shape of the Chromium `beforeinstallprompt` event. It is not in the DOM
 * lib typings (non-standard), so we model the bits we use: `prompt()` shows the
 * native install dialog and `userChoice` resolves with the user's decision.
 */
interface BeforeInstallPromptEvent extends Event {
	readonly platforms?: string[];
	prompt(): Promise<void>;
	readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/**
 * Reactive install state — the public surface consumed by `<InstallPrompt/>`.
 *
 * - `available` — a deferred `beforeinstallprompt` event is held, so we can
 *   programmatically offer install (Chromium only). The affordance shows ONLY
 *   when this is `true`.
 * - `installed` — the app has been installed (this session), via the
 *   `appinstalled` event or because we detected standalone display mode. Once
 *   set, the affordance must not show.
 */
export const install = $state({
	available: false,
	installed: false
});

// The captured, single-use deferred prompt. Held outside the runes object so the
// non-serializable Event isn't part of reactive state. Cleared after use.
let deferredPrompt: BeforeInstallPromptEvent | null = null;

/**
 * Whether the app is already running as an installed PWA (standalone display
 * mode, or iOS Safari's legacy `navigator.standalone`). SSR / no-`window` ⇒
 * `false`. Used to avoid offering install when it's already installed.
 */
function isStandalone(): boolean {
	if (!browser || typeof window === 'undefined') return false;
	try {
		if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
	} catch {
		// matchMedia unsupported / threw — fall through to the iOS check.
	}
	// iOS Safari exposes a non-standard boolean when launched from the home screen.
	const nav = navigator as Navigator & { standalone?: boolean };
	return nav.standalone === true;
}

// Guard so repeated calls (HMR re-import, a stray second mount) don't stack
// duplicate listeners.
let watching = false;

/**
 * Run the install native prompt for the held deferred event, if any. Awaits the
 * user's choice, then CLEARS the deferred event (a `beforeinstallprompt` prompt
 * is single-use — it cannot be re-prompted) and updates state from the outcome:
 * on `accepted` we optimistically mark availability gone (the `appinstalled`
 * event will confirm `installed`); on `dismissed` availability also goes since
 * the event is spent. Returns the outcome (or `null` when nothing was held, e.g.
 * SSR / already used / iOS).
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
	if (!browser || !deferredPrompt) return null;

	const event = deferredPrompt;
	// Single-use: clear immediately so a double-click can't re-invoke a spent
	// event, and so `available` reflects that the prompt is gone right away.
	deferredPrompt = null;
	install.available = false;

	try {
		await event.prompt();
		const { outcome } = await event.userChoice;
		// `appinstalled` (below) is the authoritative signal for `installed`; we
		// don't set it here so behavior is consistent across browsers that may or
		// may not fire `appinstalled` synchronously.
		return outcome;
	} catch {
		// `prompt()` can reject if called too late / out of a user gesture. The
		// event is already spent; nothing more to do.
		return null;
	}
}

/**
 * Begin listening for `beforeinstallprompt` + `appinstalled`. Browser-only and
 * idempotent; a no-op during SSR. Returns a teardown fn so a Svelte `$effect`
 * can remove the listeners on unmount (and reset the guard), mirroring
 * `startOnlineWatch`.
 */
export function startInstallWatch(): () => void {
	if (!browser) return () => {};

	// If we're already running as an installed PWA, never offer install.
	if (isStandalone()) {
		install.installed = true;
		install.available = false;
	}

	if (watching) return () => {};
	watching = true;

	const onBeforeInstallPrompt = (event: Event) => {
		// Suppress the browser's default mini-infobar so WE control the UX.
		event.preventDefault();
		// Don't offer install if it's somehow already installed.
		if (install.installed) return;
		deferredPrompt = event as BeforeInstallPromptEvent;
		install.available = true;
	};

	const onAppInstalled = () => {
		install.installed = true;
		install.available = false;
		deferredPrompt = null;
	};

	window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
	window.addEventListener('appinstalled', onAppInstalled);

	return () => {
		window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
		window.removeEventListener('appinstalled', onAppInstalled);
		watching = false;
	};
}

/**
 * Whether to show an iOS "install from the Share menu" hint. iOS Safari can
 * install PWAs but never fires `beforeinstallprompt`, so the native affordance
 * never appears. We show a tiny manual hint only on an iOS Safari that is NOT
 * already standalone. SSR / no-`window` ⇒ `false`. Kept minimal per the task:
 * detection is best-effort and never errors.
 */
export function isIosInstallable(): boolean {
	if (!browser || typeof navigator === 'undefined') return false;
	if (isStandalone()) return false;

	const ua = navigator.userAgent || '';
	// iPhone/iPod/iPad — plus iPadOS 13+ which reports as a Mac but is touch.
	const isIos =
		/iphone|ipod|ipad/i.test(ua) ||
		(/macintosh/i.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
	if (!isIos) return false;

	// Only Safari can "Add to Home Screen"; in-app webviews (CriOS/FxiOS/etc.)
	// can't, so don't nag there.
	const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
	return isSafari;
}
