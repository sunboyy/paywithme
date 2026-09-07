<script lang="ts">
	// Shared empty-state presentation (task 8.1; PLAN §14.8 "empty states").
	//
	// One small, consistent surface for every list/collection screen that can
	// legitimately render with no data — instead of a blank area or a bare table
	// header. It distinguishes "nothing exists yet" (pass a create-CTA action)
	// from "your filter matched nothing" (pass a clear-filter action) purely by
	// what the caller renders into the `action` snippet; the component itself is
	// presentation only.
	//
	// Two shapes, same content: a standalone Card, or — with `inline` — the same
	// block WITHOUT card chrome, for use inside a card that already has its own
	// header and CTA (settings sections, the members roster). Four screens used to
	// hand-copy that inline markup; this is it.
	//
	// Mobile-first & accessible: REAL text content (the title + description are
	// always rendered as text, never an icon alone), an optional decorative icon
	// (`aria-hidden`), and an optional `action` snippet the caller fills with a
	// real focusable link/form (progressive enhancement is preserved — the
	// empty-vs-nonempty decision is made in the route `load`, and CTAs are real
	// links/forms, never client-only fetches).
	//
	// Uses shadcn-svelte primitives from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored). Lives in `$lib/components/` — NOT `ui/**`.
	import type { Component, Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type IconComponent = Component<any>;

	let {
		title,
		description,
		icon,
		action,
		inline = false,
		testId = inline ? undefined : 'empty-state'
	}: {
		/** Short headline, e.g. "No groups yet". Always rendered as text. */
		title: string;
		/** One friendly sentence pointing at the obvious next step. */
		description: string;
		/** Optional decorative lucide icon component (rendered `aria-hidden`). */
		icon?: IconComponent;
		/** Optional CTA region — a real link or form (create / clear-filter). */
		action?: Snippet;
		/** Drop the Card chrome — for nesting inside a card that has its own. */
		inline?: boolean;
		/** Overrides the `data-testid` (each inline host keeps its own hook). */
		testId?: string;
	} = $props();

	const Icon = $derived(icon);
</script>

{#snippet body()}
	{#if Icon}
		<span
			class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
			aria-hidden="true"
		>
			<Icon class="size-6" />
		</span>
	{/if}
	<div class="space-y-1">
		<p class="text-base font-medium">{title}</p>
		<p class="mx-auto max-w-prose text-sm text-pretty text-muted-foreground">{description}</p>
	</div>
	{#if action}
		<div class="pt-1">
			{@render action()}
		</div>
	{/if}
{/snippet}

{#if inline}
	<div class="flex flex-col items-center gap-3 py-6 text-center" data-testid={testId}>
		{@render body()}
	</div>
{:else}
	<Card.Root data-testid={testId}>
		<Card.Content class="flex flex-col items-center gap-3 px-6 py-10 text-center">
			{@render body()}
		</Card.Content>
	</Card.Root>
{/if}
