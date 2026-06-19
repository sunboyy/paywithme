<script lang="ts">
	// `/groups/[id]/transactions` — group transaction list (task 4.7; PLAN §7, §10).
	//
	// Mobile-first: a stacked card list on small screens with a type/category
	// filter that posts via plain GET links (server-first; works without JS). Each
	// row links to the per-transaction page (task 4.11). Empty state when none.
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { formatAmount, type CurrencyCode } from '$lib/money';
	import * as Select from '$lib/components/ui/select';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import CategoryIcon from '$lib/components/CategoryIcon.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { emptyStateKind, hasActiveFilter } from '$lib/empty-state';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const settlementCurrency = $derived(data.group.settlementCurrency as CurrencyCode);

	// Empty-state branching (task 8.1): distinguish "no transactions yet" (offer
	// the create CTA) from "your filter matched nothing" (offer to clear it).
	const filterActive = $derived(hasActiveFilter(data.filters.type, data.filters.category));
	const emptyKind = $derived(emptyStateKind(data.transactions.length, filterActive));

	// Categories shown in the filter depend on the active type filter (§7.3).
	const filterCategories = $derived(
		data.filters.type === 'transfer'
			? data.categories.transfer
			: data.filters.type === 'spending'
				? data.categories.spending
				: [...data.categories.spending, ...data.categories.transfer]
	);

	const listPath = $derived(resolve('/groups/[id]/transactions', { id: data.group.id }));
	const newPath = $derived(resolve('/groups/[id]/transactions/new', { id: data.group.id }));

	/** Build the list URL for a given filter state, dropping empty params. */
	function filterUrl(next: { type?: string | null; category?: string | null }): string {
		const type = next.type !== undefined ? next.type : data.filters.type;
		const category = next.category !== undefined ? next.category : data.filters.category;
		// Plain query-string assembly (no mutable URLSearchParams instance held in
		// component state — eslint svelte/prefer-svelte-reactivity).
		const parts: string[] = [];
		if (type) parts.push(`type=${encodeURIComponent(type)}`);
		if (category) parts.push(`category=${encodeURIComponent(category)}`);
		return parts.length > 0 ? `${listPath}?${parts.join('&')}` : listPath;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>Transactions · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<div class="flex items-center justify-between gap-2">
		<div>
			<h1 class="text-2xl font-semibold">Transactions</h1>
			<span class="text-muted-foreground text-sm">
				{data.group.name} ·
				<a href={resolve('/groups/[id]/members', { id: data.group.id })} class="hover:underline">
					Members
				</a>
				·
				<a href={resolve('/groups/[id]/settle', { id: data.group.id })} class="hover:underline">
					Settle up
				</a>
				·
				<a href={resolve('/groups/[id]/activity', { id: data.group.id })} class="hover:underline">
					Activity
				</a>
			</span>
		</div>
		<Button href={newPath} class="gap-1">
			<PlusIcon class="size-4" />
			Add
		</Button>
	</div>

	<!-- Filters: type (links, no-JS friendly) + category (Select → navigate). -->
	<div class="flex flex-wrap items-center gap-2">
		<div class="flex gap-1">
			<Button
				variant={data.filters.type === null ? 'default' : 'outline'}
				size="sm"
				href={filterUrl({ type: null, category: null })}>All</Button
			>
			<Button
				variant={data.filters.type === 'spending' ? 'default' : 'outline'}
				size="sm"
				href={filterUrl({ type: 'spending', category: null })}>Spending</Button
			>
			<Button
				variant={data.filters.type === 'transfer' ? 'default' : 'outline'}
				size="sm"
				href={filterUrl({ type: 'transfer', category: null })}>Transfer</Button
			>
		</div>

		<Select.Root
			type="single"
			value={data.filters.category ?? ''}
			onValueChange={(v) =>
				goto(
					// `filterUrl` builds its path with `resolve()` then appends the filter
					// query string; the resulting string is already a resolved URL.
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					filterUrl({ category: v === '' ? null : v })
				)}
		>
			<Select.Trigger class="w-48">
				{filterCategories.find((c) => c.id === data.filters.category)?.name ?? 'All categories'}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="">All categories</Select.Item>
				{#each filterCategories as category (category.id)}
					<Select.Item value={category.id} label={category.name}>
						<CategoryIcon name={category.icon} class="size-4" />
						{category.name}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>

	{#if emptyKind === 'filtered-empty'}
		<!-- Filtered-empty (task 8.1): the filter matched nothing → offer to clear
		     it (a real link back to the unfiltered list, no-JS friendly). -->
		<EmptyState
			icon={FilterXIcon}
			title="No transactions match these filters"
			description="Nothing here for the current filter. Try a different type or category, or clear the filter to see everything."
		>
			{#snippet action()}
				<!-- `filterUrl` returns a `resolve()`d path with an appended query string
				     (already a resolved URL); Button's `href` is the same link control the
				     filter buttons above use. -->
				<Button variant="outline" href={filterUrl({ type: null, category: null })}>
					Clear filter
				</Button>
			{/snippet}
		</EmptyState>
	{:else if emptyKind === 'nothing-yet'}
		<!-- Nothing-yet (task 8.1): no transactions at all → the create CTA. -->
		<EmptyState
			icon={ReceiptIcon}
			title="No transactions yet"
			description="Add your first transaction to start splitting spending and tracking who owes who."
		>
			{#snippet action()}
				<Button href={newPath}>Add transaction</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<ul class="space-y-2">
			{#each data.transactions as txn (txn.id)}
				<li>
					<!-- Links to the per-transaction view/edit page (task 4.11). -->
					<a
						href={resolve('/groups/[id]/transactions/[txid]', {
							id: data.group.id,
							txid: txn.id
						})}
						class="bg-card hover:bg-accent flex items-center gap-3 rounded-lg border p-3 transition-colors"
					>
						<span
							class="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full"
						>
							<CategoryIcon name={txn.categoryIcon} class="size-5" />
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-2">
								<span class="truncate font-medium">{txn.title}</span>
								<Badge variant={txn.type === 'transfer' ? 'secondary' : 'outline'} class="shrink-0">
									{txn.type}
								</Badge>
							</span>
							<span class="text-muted-foreground block text-xs">
								{txn.categoryName} · {formatDate(txn.createdAt)}
							</span>
						</span>
						<!-- §7.6 display: show the ORIGINAL amount + currency; for a foreign
						     transaction the settlement equivalent is secondary text below. -->
						<span class="shrink-0 text-right">
							<span class="block font-medium tabular-nums">
								{formatAmount(txn.amountTotal, txn.currency)}
							</span>
							{#if txn.isForeign}
								<span class="text-muted-foreground block text-xs tabular-nums">
									{formatAmount(txn.amountTotalSettlement, settlementCurrency)}
								</span>
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
