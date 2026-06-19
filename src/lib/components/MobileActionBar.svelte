<script lang="ts">
	// Reusable mobile-first sticky action bar (task 8.2; PLAN decision #28, §10).
	//
	// The app is "primarily used on phones", so the primary action on the LONG task
	// screens (the itemized add/edit transaction form especially) must stay
	// thumb-reachable one-handed. This wraps a screen's primary action(s) — passed
	// in via the default slot — in a container that is sticky-anchored to the bottom
	// of the viewport on small screens and respects the iOS safe-area inset, then
	// reverts to a normal inline block from `sm:` up (where reachability isn't a
	// concern and a floating bar would be noise).
	//
	// Presentation/layout only: it does NOT own the form or the submit button — the
	// REAL submit lives inside the slotted content, which is rendered inside the
	// real <form> in the parent, so progressive enhancement is preserved (a no-JS
	// submit still works; the sticky bar is pure CSS positioning around it).
	//
	// Lives in `$lib/components/` — NOT `ui/**` (those are shadcn CLI-generated and
	// never hand-authored). Uses no shadcn primitive itself; the caller passes real
	// shadcn <Button>s into the slot.
	import type { Snippet } from 'svelte';

	let {
		children,
		class: className
	}: {
		/** The primary action(s) — a real submit button (and optional helper text). */
		children: Snippet;
		/** Optional extra classes for the inner content wrapper. */
		class?: string;
	} = $props();
</script>

<!--
	Mobile (base): sticky to the bottom of the scroll container, full-bleed within
	the app shell column, with a subtle top border + blurred background so content
	scrolling underneath stays legible, and bottom padding that clears the iOS home
	indicator (`env(safe-area-inset-bottom)`).

	`sm:` and up: drop the sticky/blur/border chrome and render as a normal block —
	on larger viewports the action is already reachable, so a floating bar is noise.
-->
<div
	data-testid="mobile-action-bar"
	class="bg-background/95 supports-backdrop-filter:bg-background/80 sticky bottom-0 z-10 -mx-4 mt-6 border-t px-4 pt-3 backdrop-blur sm:static sm:mx-0 sm:mt-6 sm:border-0 sm:bg-transparent sm:px-0 sm:pt-0 sm:backdrop-blur-none"
	style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom));"
>
	<div class={className}>
		{@render children()}
	</div>
</div>
