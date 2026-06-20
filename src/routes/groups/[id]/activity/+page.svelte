<script lang="ts">
	// `/groups/[id]/activity` — the group activity feed (task 6.2; PLAN §12.1, §10).
	//
	// Mobile-first, server-first read-only page mirroring the transactions / settle
	// pages: a header with the group name + sibling nav, optional filter controls as
	// plain GET links (work without JS), a divided list of entries, and an empty
	// state. Each entry shows the actor, a human action label, the durable summary,
	// and BOTH relative + absolute time (rendered in the viewer's locale/timezone,
	// computed client-side from the ISO string).
	//
	// shadcn-svelte components are used from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored / edited here).
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { emptyStateKind, hasActiveFilter } from '$lib/empty-state';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import { actionLabel, absoluteTime, relativeTime } from '$lib/activity-labels';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const activityPath = $derived(resolve('/groups/[id]/activity', { id: data.group.id }));

	// Empty-state branching (task 8.1): a filtered-empty feed offers to clear the
	// filter; an unfiltered-empty feed is the rare "nothing has happened yet".
	const filterActive = $derived(hasActiveFilter(data.filters.entity, data.filters.actor));
	const emptyKind = $derived(emptyStateKind(data.entries.length, filterActive));

	/** Build the feed URL for a given filter state, dropping empty params. */
	function filterUrl(next: { entity?: string | null; actor?: string | null }): string {
		const entity = next.entity !== undefined ? next.entity : data.filters.entity;
		const actor = next.actor !== undefined ? next.actor : data.filters.actor;
		// Plain query-string assembly (no mutable URLSearchParams instance held in
		// component state — eslint svelte/prefer-svelte-reactivity).
		const parts: string[] = [];
		if (entity) parts.push(`entity=${encodeURIComponent(entity)}`);
		if (actor) parts.push(`actor=${encodeURIComponent(actor)}`);
		return parts.length > 0 ? `${activityPath}?${parts.join('&')}` : activityPath;
	}

	// Action labels + relative/absolute time helpers are shared with the
	// per-transaction history section (`$lib/activity-labels`) — ONE source of truth.
	const actorLabel = (userId: string): string =>
		data.actors.find((a) => a.userId === userId)?.displayName ?? '';
</script>

<svelte:head>
	<title>Activity · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<div>
		<h1 class="text-2xl font-semibold">Activity</h1>
		<span class="text-muted-foreground text-sm">
			<a href={resolve('/groups/[id]', { id: data.group.id })} class="hover:underline">
				{data.group.name}
			</a>
			·
			<a href={resolve('/groups/[id]/transactions', { id: data.group.id })} class="hover:underline">
				Transactions
			</a>
			·
			<a href={resolve('/groups/[id]/members', { id: data.group.id })} class="hover:underline">
				Members
			</a>
			·
			<a href={resolve('/groups/[id]/settle', { id: data.group.id })} class="hover:underline">
				Settle up
			</a>
			·
			<a href={resolve('/groups/[id]/settings', { id: data.group.id })} class="hover:underline">
				Settings
			</a>
		</span>
	</div>

	<!-- Filters: entity type (links, no-JS friendly) + actor (Select → navigate). -->
	<div class="flex flex-wrap items-center gap-2">
		<div class="flex flex-wrap gap-1">
			<Button
				variant={data.filters.entity === null ? 'default' : 'outline'}
				size="sm"
				href={filterUrl({ entity: null })}>All</Button
			>
			{#each data.entityTypes as entityType (entityType)}
				<Button
					variant={data.filters.entity === entityType ? 'default' : 'outline'}
					size="sm"
					href={filterUrl({ entity: entityType })}
					class="capitalize">{entityType}</Button
				>
			{/each}
		</div>

		{#if data.actors.length > 0}
			<Select.Root
				type="single"
				value={data.filters.actor ?? ''}
				onValueChange={(v) =>
					goto(
						// `filterUrl` builds its path with `resolve()` then appends the filter
						// query string; the resulting string is already a resolved URL.
						// eslint-disable-next-line svelte/no-navigation-without-resolve
						filterUrl({ actor: v === '' ? null : v })
					)}
			>
				<Select.Trigger class="w-48">
					{data.filters.actor ? actorLabel(data.filters.actor) : 'Everyone'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="">Everyone</Select.Item>
					{#each data.actors as actor (actor.userId)}
						<Select.Item value={actor.userId} label={actor.displayName}>
							{actor.displayName}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
	</div>

	{#if emptyKind === 'filtered-empty'}
		<!-- Filtered-empty (task 8.1): clear the filter to see the full feed. -->
		<EmptyState
			icon={FilterXIcon}
			title="No activity matches these filters"
			description="Nothing here for the current filter. Try a different entity or person, or clear the filter to see everything."
		>
			{#snippet action()}
				<!-- `filterUrl` returns a `resolve()`d path with an appended query string
				     (already a resolved URL); Button's `href` is the same link control the
				     filter buttons above use. -->
				<Button variant="outline" href={filterUrl({ entity: null, actor: null })}>
					Clear filter
				</Button>
			{/snippet}
		</EmptyState>
	{:else if emptyKind === 'nothing-yet'}
		<!-- Nothing-yet (task 8.1): the feed is empty (rare — any mutation writes
		     an audit row). No CTA: activity is a byproduct of using the group. -->
		<EmptyState
			icon={HistoryIcon}
			title="No activity yet"
			description="Actions in this group — transactions, members, settlements — will appear here, newest first."
		/>
	{:else}
		<Card.Root>
			<Card.Content class="divide-border divide-y p-0">
				{#each data.entries as entry (entry.id)}
					<div class="flex flex-col gap-1 p-3">
						<div class="flex items-start justify-between gap-2">
							<p class="min-w-0 text-sm">
								<span class="font-medium">{entry.actorName}</span>
								<span class="text-muted-foreground"> {actionLabel(entry.action)} </span>
								<Badge variant="outline" class="ml-1 align-middle capitalize">
									{entry.entityType}
								</Badge>
							</p>
							<!-- Relative time (locale-aware), absolute on hover/title. -->
							<time
								datetime={entry.occurredAt}
								title={absoluteTime(entry.occurredAt)}
								class="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
							>
								{relativeTime(entry.occurredAt)}
							</time>
						</div>
						<p class="text-sm">{entry.summary}</p>
						<p class="text-muted-foreground text-xs">{absoluteTime(entry.occurredAt)}</p>
					</div>
				{/each}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
