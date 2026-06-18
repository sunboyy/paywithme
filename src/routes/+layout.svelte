<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import favicon from '$lib/assets/favicon.svg';
	import { Button } from '$lib/components/ui/button';
	import { Toaster } from '$lib/components/ui/sonner';
	import { registerPwa } from '$lib/pwa/register.svelte';
	import { startOnlineWatch } from '$lib/pwa/online.svelte';
	import { startInstallWatch } from '$lib/pwa/install.svelte';
	import OfflineNotice from '$lib/components/OfflineNotice.svelte';
	import InstallPrompt from '$lib/components/InstallPrompt.svelte';

	let { children, data } = $props();

	// Activate the service worker once, browser-only (PLAN §11 / §11.1). This is
	// a safe no-op during SSR and in dev/preview builds where no SW is emitted
	// (vite.config.ts `devOptions.enabled: false`), so it cannot hijack the e2e
	// run. Registration uses `registerType: 'prompt'`: it never auto-reloads —
	// the update/install/offline UIs (tasks 7.5 / 7.4 / 7.3) consume the reactive
	// `pwaState` and `applyUpdate()` exposed by the register module.
	$effect(() => {
		if (browser) registerPwa();
	});

	// Watch connectivity, browser-only, and tear the listeners down on unmount
	// (PLAN §11). The shared `network.offline` flag drives the <OfflineNotice/>
	// banner here and the per-form write disabling on the write surfaces. SSR
	// assumes online (see online.svelte.ts), so first paint never blocks writes.
	$effect(() => {
		if (browser) return startOnlineWatch();
	});

	// Watch for the "Add to home screen" install opportunity, browser-only, with
	// teardown (PLAN §11). This captures Chromium's `beforeinstallprompt` (and the
	// `appinstalled` event) and exposes reactive availability that <InstallPrompt/>
	// reads to show a small, dismissible install affordance. SSR / iOS never set
	// availability, so nothing shows there. Pure client UX — does not touch the
	// §11.1 caching contract.
	$effect(() => {
		if (browser) return startInstallWatch();
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!--
	Root app shell (PLAN §10, decision #28): mobile-first, fully responsive chrome.
	- Full-bleed (but padded) on phones; centered, constrained column on larger
	  viewports via `max-w-screen-sm` + `mx-auto`.
	- `min-h-dvh` + flex column so the main region grows and any future
	  bottom-anchored action region stays reachable one-handed.
	- Safe-area padding so content clears notches / home indicators on phones.
	- App-wide <Toaster /> is mounted once here so toasts work everywhere.
	- Auth-aware chrome: when a session exists (`data.user`, projected by
	  `+layout.server.ts`) the header shows a compact user indicator + a logout
	  button. Logout is a real form POST to `/logout` (works without JS), upgraded
	  by `use:enhance` when JS is present.
-->
<div class="bg-background text-foreground flex min-h-dvh flex-col">
	<div class="mx-auto flex w-full max-w-screen-sm flex-1 flex-col">
		<header
			class="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-10 border-b backdrop-blur"
			style="padding-top: env(safe-area-inset-top);"
		>
			<div class="flex h-14 items-center justify-between px-4">
				<a href={resolve('/')} class="text-lg font-semibold tracking-tight">Pay with me</a>
				<!-- Auth-aware header actions. -->
				<div class="flex min-w-0 items-center gap-2">
					{#if data.user}
						<a
							href={resolve('/settings')}
							class="text-muted-foreground max-w-[40vw] truncate text-sm hover:underline"
							title="Account settings"
						>
							{data.user.name || data.user.email}
						</a>
						<form method="POST" action="/logout" use:enhance>
							<Button type="submit" variant="ghost" size="sm">Log out</Button>
						</form>
					{:else}
						<a href={resolve('/login')} class="text-muted-foreground text-sm hover:underline">
							Sign in
						</a>
					{/if}
				</div>
			</div>
		</header>

		<!-- Sticky, accessible "you're offline" indicator (PLAN §11). Renders only
		     while offline; reads remain usable, writes are disabled per-surface. -->
		<OfflineNotice />

		<!-- "Add to home screen" affordance (PLAN §11). Shows only when the
		     browser actually offers install (Chromium) or as a tiny iOS Share-menu
		     hint; dismissible for the session, hidden when already installed. -->
		<InstallPrompt />

		<main
			class="flex-1 px-4 py-6"
			style="padding-bottom: max(1.5rem, env(safe-area-inset-bottom));"
		>
			{@render children()}
		</main>

		<!--
			Structural placeholder for bottom-reachable primary actions (#28).
			Feature pages can render their primary CTA into a mobile-anchored region
			like this so it stays thumb-reachable. Empty for now (no real actions yet).
		-->
	</div>
</div>

<Toaster />
