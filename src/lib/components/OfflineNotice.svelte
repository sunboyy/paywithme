<script lang="ts">
	// App-shell "you're offline" indicator (PLAN §11 / §11.1).
	//
	// Unobtrusive banner that appears only while the browser reports offline. It's
	// accessible (a `role="status"` live region + an icon, NOT color-only) and
	// mobile-first (full-width sticky strip under the header, large enough to read
	// one-handed). It reads the shared reactive `network.offline` flag — the
	// watcher itself is started once from the root layout.
	//
	// This is purely a UX surface: reads stay usable offline; the matching write
	// disabling lives on the write surfaces via `writeDisabled()`.
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
	import { network } from '$lib/pwa/online.svelte';
	import { OFFLINE_WRITE_MESSAGE } from '$lib/pwa/offline-writes';
</script>

{#if network.offline}
	<div
		role="status"
		aria-live="polite"
		class="bg-muted text-muted-foreground flex items-center justify-center gap-2 border-b px-4 py-2 text-sm"
		data-testid="offline-notice"
	>
		<WifiOffIcon class="size-4 shrink-0" aria-hidden="true" />
		<span>{OFFLINE_WRITE_MESSAGE}</span>
	</div>
{/if}
