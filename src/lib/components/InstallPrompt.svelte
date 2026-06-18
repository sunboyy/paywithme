<script lang="ts">
	// App-shell "Add to home screen" install affordance (PLAN §11).
	//
	// Unobtrusive, mobile-first, accessible install prompt. It renders ONLY when
	// the browser actually offers install (`install.available`, Chromium), or — on
	// iOS Safari, which never fires `beforeinstallprompt` — a tiny manual hint
	// pointing at the Share menu. It never shows when already installed/standalone,
	// and it's dismissible for the session so we don't nag (PLAN §11: don't nag).
	//
	// This is pure client UX around the install event; it does NOT touch the §11.1
	// caching contract. The native prompt is driven by `promptInstall()` from the
	// reactive `install.svelte.ts` module (watcher started by the root layout).
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ShareIcon from '@lucide/svelte/icons/share-2';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { install, promptInstall, isIosInstallable } from '$lib/pwa/install.svelte';
	import { network } from '$lib/pwa/online.svelte';

	// Session-scoped dismissal. We persist to sessionStorage (best-effort,
	// SSR-safe) so navigations within the tab keep it hidden, but a fresh session
	// can offer again. A reactive mirror drives the conditional render.
	const STORAGE_KEY = 'pwm:install-dismissed';

	let dismissed = $state(false);

	// Seed the reactive flag from sessionStorage once mounted (browser-only).
	$effect(() => {
		try {
			dismissed = sessionStorage.getItem(STORAGE_KEY) === '1';
		} catch {
			// sessionStorage unavailable (private mode / SSR): just don't persist.
		}
	});

	function dismiss() {
		dismissed = true;
		try {
			sessionStorage.setItem(STORAGE_KEY, '1');
		} catch {
			// Best-effort; the in-memory flag still hides it for this view.
		}
	}

	async function onInstall() {
		await promptInstall();
		// Whatever the outcome, the deferred prompt is spent — `install.available`
		// is already cleared by the module, so the affordance hides itself.
	}

	// iOS hint eligibility (UA-based, stable). SSR-safe: `isIosInstallable()`
	// returns false off the browser, so SSR and the first browser paint agree.
	const iosHint = $derived(isIosInstallable());

	// Don't compete with the offline banner: installing requires the network
	// anyway, and stacking shell banners is noisy.
	const showNative = $derived(install.available && !install.installed && !dismissed);
	const showIos = $derived(iosHint && !install.installed && !dismissed && !network.offline);
</script>

{#if showNative}
	<div
		class="bg-muted text-foreground flex items-center gap-3 border-b px-4 py-2 text-sm"
		data-testid="install-prompt"
	>
		<DownloadIcon class="size-5 shrink-0" aria-hidden="true" />
		<span class="min-w-0 flex-1">Install Pay with me for quick, app-like access.</span>
		<Button type="button" size="sm" onclick={onInstall}>Install</Button>
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="size-8 shrink-0"
			onclick={dismiss}
			aria-label="Dismiss install prompt"
		>
			<XIcon class="size-4" aria-hidden="true" />
		</Button>
	</div>
{:else if showIos}
	<div
		class="bg-muted text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-sm"
		data-testid="install-prompt-ios"
	>
		<ShareIcon class="size-4 shrink-0" aria-hidden="true" />
		<span class="min-w-0 flex-1">
			To install: tap Share, then <span class="font-medium">Add to Home Screen</span>.
		</span>
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="size-8 shrink-0"
			onclick={dismiss}
			aria-label="Dismiss install hint"
		>
			<XIcon class="size-4" aria-hidden="true" />
		</Button>
	</div>
{/if}
