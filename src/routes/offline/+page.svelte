<script lang="ts">
	// Auth-agnostic offline shell content (PLAN §11 / §11.1).
	//
	// This is the static, prerendered "you're offline" page (see +page.ts). It
	// contains NO user/session data — only generic copy + a retry affordance — so
	// it satisfies §11.1's "precached HTML shell must be auth-agnostic" rule even
	// if it were ever cached. It also doubles as a reachable destination when the
	// app wants to point somewhere explicit about offline state.
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off';

	function retry() {
		// Browser-only; safe because this runs from a click handler in the browser.
		location.reload();
	}
</script>

<svelte:head>
	<title>Offline · Pay with me</title>
</svelte:head>

<div class="flex flex-col items-center gap-4 py-12 text-center">
	<WifiOffIcon class="text-muted-foreground size-10" aria-hidden="true" />
	<h1 class="text-2xl font-semibold tracking-tight">You're offline</h1>
	<p class="text-muted-foreground max-w-sm text-sm">
		Pay with me needs a connection to load and save your groups. Anything already loaded stays
		readable, but creating or editing isn't available while offline.
	</p>
	<div class="flex flex-wrap items-center justify-center gap-2">
		<Button onclick={retry}>Try again</Button>
		<Button href={resolve('/')} variant="outline">Go home</Button>
	</div>
</div>
