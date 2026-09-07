<script lang="ts">
	// Shared horizontal tab bar (the app's ONE section-navigation pattern).
	//
	// Both group pages (`GroupNav`) and account settings (`SettingsNav`) render
	// through this, so a tab row looks and behaves identically wherever it appears:
	// the active tab carries `aria-current="page"` and a coloured underline, every
	// tab is icon-labelled, and the bar scrolls horizontally on narrow viewports
	// with a right-edge fade so off-screen tabs stay discoverable.
	import type { Component } from 'svelte';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type IconComponent = Component<any>;

	export type TabNavItem = {
		key: string;
		label: string;
		icon: IconComponent;
		/** Already resolved with `resolve()` by the caller. */
		href: string;
	};

	let {
		label,
		items,
		current
	}: {
		/** Accessible name for the <nav>, e.g. "Group sections". */
		label: string;
		items: TabNavItem[];
		/** `key` of the active item. */
		current: string;
	} = $props();
</script>

<!--
	The scroller is wrapped so the right-edge fade can sit ON TOP of it: at 390px
	only three of six tabs fit, and with no fade the rest look like they don't
	exist. The fade is `pointer-events-none` so it never eats a tap, and is hidden
	once every tab fits (`sm:hidden`). Scroll-snap lands the swipe on tab edges.
-->
<div class="relative border-b">
	<div
		class="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-background to-transparent sm:hidden"
		aria-hidden="true"
	></div>
	<nav aria-label={label} class="snap-x snap-mandatory overflow-x-auto">
		<!-- Every `item.href` is already a resolved path (built with `resolve()` in the
		     calling component), so the navigation-without-resolve rule is satisfied
		     at the source. -->
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<ul class="flex min-w-max gap-1">
			{#each items as item (item.key)}
				{@const Icon = item.icon}
				{@const active = item.key === current}
				<li class="snap-start">
					<a
						href={item.href}
						aria-current={active ? 'page' : undefined}
						class="flex items-center gap-1.5 border-b-2 p-3 text-sm font-medium whitespace-nowrap transition-colors {active
							? 'border-primary text-foreground'
							: 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}"
					>
						<Icon class="size-4" aria-hidden="true" />
						{item.label}
					</a>
				</li>
			{/each}
		</ul>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</nav>
</div>
