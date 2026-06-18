<script lang="ts">
	// App-shell "a new version is available" prompt-to-reload (PLAN §11.1).
	//
	// Closes the "SW update vs. stale client code" loop: on deploy a waiting SW
	// holds a new version, but we never auto-reload (that could break an in-flight
	// auth flow across versions — §11.1). Instead we surface a small, accessible,
	// non-blocking affordance whenever `pwaState.needRefresh` is true and let the
	// user trigger the reload explicitly via `applyUpdate()`, which is the ONLY
	// path that activates the waiting SW (SKIP_WAITING) and reloads the page.
	//
	// This is pure UI consuming the existing 7.2 seam (register.svelte.ts); it does
	// NOT touch the §11.1 caching contract or the registration semantics.
	//
	// Accessibility: `role="status"` + `aria-live="polite"` so screen readers
	// announce the available update without interrupting; a real <Button> with an
	// accessible name; an icon so it's not color-only.
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import { pwaState, applyUpdate } from '$lib/pwa/register.svelte';

	// Session-scoped dismissal (mirrors InstallPrompt). An update is higher
	// priority than the install nudge, so we keep it visible until applied or
	// explicitly dismissed. A waiting update reappearing on the next load is fine
	// and arguably desirable — the new code is still pending.
	const STORAGE_KEY = 'pwm:update-dismissed';

	let dismissed = $state(false);

	// Seed the reactive flag from sessionStorage once mounted (browser-only).
	$effect(() => {
		try {
			dismissed = sessionStorage.getItem(STORAGE_KEY) === '1';
		} catch {
			// sessionStorage unavailable (private mode / SSR): just don't persist.
		}
	});

	// `applyUpdate()` reloads the page, so once clicked there is nothing left to
	// guard against; if it ever returns without reloading (no waiting SW) the
	// banner simply stays. We don't disable optimistically to avoid a dead button.
	function onUpdate() {
		void applyUpdate();
	}

	function dismiss() {
		dismissed = true;
		try {
			sessionStorage.setItem(STORAGE_KEY, '1');
		} catch {
			// Best-effort; the in-memory flag still hides it for this view.
		}
	}

	const show = $derived(pwaState.needRefresh && !dismissed);
</script>

{#if show}
	<div
		role="status"
		aria-live="polite"
		class="bg-muted text-foreground flex items-center gap-3 border-b px-4 py-2 text-sm"
		data-testid="update-prompt"
	>
		<RefreshCwIcon class="size-5 shrink-0" aria-hidden="true" />
		<span class="min-w-0 flex-1">A new version of Pay with me is available.</span>
		<Button type="button" size="sm" onclick={onUpdate}>Reload</Button>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="shrink-0"
			onclick={dismiss}
			aria-label="Dismiss update prompt"
		>
			Later
		</Button>
	</div>
{/if}
