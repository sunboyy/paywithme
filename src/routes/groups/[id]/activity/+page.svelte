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
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const activityPath = $derived(resolve('/groups/[id]/activity', { id: data.group.id }));

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

	// Human-readable label per audit action verb (PLAN §12.1 "action"). Falls back to
	// the raw verb for any future action not yet mapped.
	const ACTION_LABELS: Record<string, string> = {
		create: 'created',
		edit: 'edited',
		delete: 'deleted',
		restore: 'restored',
		add: 'added',
		deactivate: 'deactivated',
		reactivate: 'reactivated',
		revoke: 'revoked',
		rename: 'renamed',
		currency_set: 'set currency'
	};
	function actionLabel(action: string): string {
		return ACTION_LABELS[action] ?? action;
	}

	const actorLabel = (userId: string): string =>
		data.actors.find((a) => a.userId === userId)?.displayName ?? '';

	/** Absolute time in the viewer's locale/timezone (§12.1). */
	function absoluteTime(iso: string): string {
		return new Date(iso).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
		{ amount: 60, unit: 'second' },
		{ amount: 60, unit: 'minute' },
		{ amount: 24, unit: 'hour' },
		{ amount: 7, unit: 'day' },
		{ amount: 4.34524, unit: 'week' },
		{ amount: 12, unit: 'month' },
		{ amount: Number.POSITIVE_INFINITY, unit: 'year' }
	];
	/** Locale-aware "2 hours ago" / "in 3 days" relative time from an ISO string. */
	function relativeTime(iso: string): string {
		let delta = (new Date(iso).getTime() - Date.now()) / 1000; // seconds, signed
		for (const { amount, unit } of DIVISIONS) {
			if (Math.abs(delta) < amount) return RELATIVE.format(Math.round(delta), unit);
			delta /= amount;
		}
		return RELATIVE.format(Math.round(delta), 'year');
	}
</script>

<svelte:head>
	<title>Activity · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<div>
		<h1 class="text-2xl font-semibold">Activity</h1>
		<span class="text-muted-foreground text-sm">
			{data.group.name} ·
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

	{#if data.entries.length === 0}
		<Card.Root>
			<Card.Content class="py-10 text-center">
				<p class="text-muted-foreground text-sm">
					{#if data.filters.entity || data.filters.actor}
						No activity matches these filters.
					{:else}
						No activity yet. Actions in this group will appear here.
					{/if}
				</p>
			</Card.Content>
		</Card.Root>
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
