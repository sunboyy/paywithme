<script lang="ts">
	// The one page-heading treatment (PLAN §10).
	//
	// Every screen used to hand-roll its own: some put "Back" as a ghost button at
	// the BOTTOM, some as a chevron link at the top, some had no description at
	// all. This is the single shape — optional back link, `<h1>`, optional
	// description, optional trailing actions — so a user always finds the way out
	// in the same place.
	import type { Snippet } from 'svelte';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';

	let {
		title,
		description,
		backHref,
		backLabel = 'Back',
		actions
	}: {
		title: string;
		/** One sentence saying what this screen is for. */
		description?: string;
		/** Already resolved with `resolve()`. Renders the top-left back link. */
		backHref?: string;
		backLabel?: string;
		/** Trailing controls, right-aligned beside the title on wide viewports. */
		actions?: Snippet;
	} = $props();
</script>

<div class="space-y-2">
	{#if backHref}
		<!-- `backHref` is already a resolved path (the caller builds it with
		     `resolve()`), so the rule is satisfied at the source. -->
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a
			href={backHref}
			class="-ml-1 inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
		>
			<ChevronLeftIcon class="size-4" aria-hidden="true" />
			{backLabel}
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}

	<div class="flex flex-wrap items-start justify-between gap-3">
		<!-- `flex-1` (basis 0) so a long description SHRINKS rather than pushing the
		     actions onto their own line. -->
		<div class="min-w-0 flex-1 space-y-1">
			<h1 class="truncate text-2xl font-semibold tracking-tight">{title}</h1>
			{#if description}
				<p class="max-w-prose text-sm text-pretty text-muted-foreground">{description}</p>
			{/if}
		</div>
		{#if actions}
			<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
		{/if}
	</div>
</div>
