<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import { Toaster } from '$lib/components/ui/sonner';

	let { children } = $props();
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
	- Auth-aware nav / user menu is intentionally NOT here (Phase 2: no session).
-->
<div class="bg-background text-foreground flex min-h-dvh flex-col">
	<div class="mx-auto flex w-full max-w-screen-sm flex-1 flex-col">
		<header
			class="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-10 border-b backdrop-blur"
			style="padding-top: env(safe-area-inset-top);"
		>
			<div class="flex h-14 items-center justify-between px-4">
				<a href={resolve('/')} class="text-lg font-semibold tracking-tight">Pay with me</a>
				<!-- Placeholder for page-level header actions (filled by feature pages later). -->
				<div class="flex items-center gap-2"></div>
			</div>
		</header>

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
