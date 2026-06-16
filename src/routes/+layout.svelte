<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import favicon from '$lib/assets/favicon.svg';
	import { Button } from '$lib/components/ui/button';
	import { Toaster } from '$lib/components/ui/sonner';

	let { children, data } = $props();
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
