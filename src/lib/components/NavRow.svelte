<script lang="ts">
	// A "this lives on its own screen" row: icon, title, one line of description,
	// chevron. The consistent alternative to the full-width outline BUTTON some
	// screens used for the same job — a button says "act", a chevron row says
	// "go somewhere", and settings is full of the latter.
	import type { Component } from 'svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type IconComponent = Component<any>;

	let {
		href,
		title,
		description,
		icon
	}: {
		/** Already resolved with `resolve()`. */
		href: string;
		title: string;
		description?: string;
		icon?: IconComponent;
	} = $props();

	const Icon = $derived(icon);
</script>

<!-- `href` is already a resolved path (built with `resolve()` by the caller), so
     the navigation-without-resolve rule is satisfied at the source. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<a
	{href}
	class="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 py-3 transition-colors hover:bg-accent/50"
>
	{#if Icon}
		<span
			class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
			aria-hidden="true"
		>
			<Icon class="size-4" />
		</span>
	{/if}
	<span class="min-w-0 flex-1">
		<span class="block text-sm font-medium">{title}</span>
		{#if description}
			<span class="block text-sm text-pretty text-muted-foreground">{description}</span>
		{/if}
	</span>
	<ChevronRightIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
</a>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
