<script lang="ts">
	// `/groups/[id]/transactions` — group transaction list (task 4.7; PLAN §7, §10).
	//
	// Mobile-first: a stacked card list on small screens with a type/category/member
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
	import GroupNav from '$lib/components/GroupNav.svelte';
	import { emptyStateKind, hasActiveFilter } from '$lib/empty-state';
	import { groupByDay } from '$lib/date-groups';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const settlementCurrency = $derived(data.group.settlementCurrency as CurrencyCode);

	// Empty-state branching (task 8.1): distinguish "no transactions yet" (offer
	// the create CTA) from "your filter matched nothing" (offer to clear it).
	const filterActive = $derived(
		hasActiveFilter(data.filters.type, data.filters.category, data.filters.member)
	);
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
	function filterUrl(next: {
		type?: string | null;
		category?: string | null;
		member?: string | null;
		role?: string | null;
	}): string {
		const type = next.type !== undefined ? next.type : data.filters.type;
		const category = next.category !== undefined ? next.category : data.filters.category;
		const member = next.member !== undefined ? next.member : data.filters.member;
		// `role` only means something alongside a member, so clearing the member
		// clears the role with it — otherwise a stale `role=paid` would sit in the URL
		// doing nothing and reappear the moment another person was selected.
		const role = member ? (next.role !== undefined ? next.role : data.filters.role) : null;
		// Plain query-string assembly (no mutable URLSearchParams instance held in
		// component state — eslint svelte/prefer-svelte-reactivity).
		const parts: string[] = [];
		if (type) parts.push(`type=${encodeURIComponent(type)}`);
		if (category) parts.push(`category=${encodeURIComponent(category)}`);
		if (member) parts.push(`member=${encodeURIComponent(member)}`);
		if (role) parts.push(`role=${encodeURIComponent(role)}`);
		return parts.length > 0 ? `${listPath}?${parts.join('&')}` : listPath;
	}

	/** Clear every filter at once (the empty-state / "clear filter" target). */
	const unfilteredUrl = $derived(
		filterUrl({ type: null, category: null, member: null, role: null })
	);

	// Member filter (§10 "show only what relates to me"). The viewer's own member
	// slot is pinned first and labelled "Me" — it is the reason this control exists.
	// A solo group has nothing to filter, so the control is hidden below 2 members.
	const memberOptions = $derived(
		[...data.members].sort((a, b) => Number(b.isSelf) - Number(a.isSelf))
	);
	const selectedMember = $derived(data.members.find((m) => m.id === data.filters.member));

	/** Dropdown label: "Me (Ada)" for the viewer, plus an inactive marker (§6.3). */
	function memberLabel(m: { displayName: string; isSelf: boolean; isInactive: boolean }): string {
		const base = m.isSelf ? `Me (${m.displayName})` : m.displayName;
		return m.isInactive ? `${base} (inactive)` : base;
	}

	// Day sections instead of a per-row date (which repeated the same string on
	// every line of a day's spending). The server already returns newest-first, and
	// `groupByDay` groups consecutive runs, so that order is preserved exactly.
	const dayGroups = $derived(groupByDay(data.transactions, (t) => t.createdAt));
</script>

<svelte:head>
	<title>Transactions · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<header class="space-y-3">
		<div class="flex items-center justify-between gap-3">
			<h1 class="truncate text-2xl font-semibold tracking-tight">{data.group.name}</h1>
			<Button href={newPath} class="shrink-0 gap-1">
				<PlusIcon class="size-4" aria-hidden="true" />
				Add
			</Button>
		</div>
		<GroupNav groupId={data.group.id} current="transactions" />
	</header>

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

		<!-- Member filter (§10): "show only what relates to me / to <person>".
		     Pointless in a solo group, so it only appears from 2 members up. -->
		{#if data.members.length > 1}
			<Select.Root
				type="single"
				value={data.filters.member ?? ''}
				onValueChange={(v) =>
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					goto(filterUrl({ member: v === '' ? null : v }))}
			>
				<Select.Trigger class="w-48">
					{selectedMember ? memberLabel(selectedMember) : 'Everyone'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="">Everyone</Select.Item>
					{#each memberOptions as member (member.id)}
						<Select.Item value={member.id} label={memberLabel(member)}>
							{memberLabel(member)}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
	</div>

	<!-- Which SIDE of the transaction the selected person is on. Only meaningful
	     once someone is selected, so it appears with them. Plain links like the
	     type chips above — no JS required. -->
	{#if selectedMember}
		<div class="flex flex-wrap items-center gap-2">
			<!-- Name then bare verbs, rather than a sentence — "Ada · Paid" reads the
			     same whoever is selected, so the copy needs no pronoun. -->
			<span class="text-xs text-muted-foreground">
				{selectedMember.isSelf ? 'Me' : selectedMember.displayName}
			</span>
			<div class="flex gap-1">
				<Button
					variant={data.filters.role === null ? 'default' : 'outline'}
					size="sm"
					href={filterUrl({ role: null })}>Either</Button
				>
				<Button
					variant={data.filters.role === 'paid' ? 'default' : 'outline'}
					size="sm"
					href={filterUrl({ role: 'paid' })}>Paid</Button
				>
				<Button
					variant={data.filters.role === 'owes' ? 'default' : 'outline'}
					size="sm"
					href={filterUrl({ role: 'owes' })}>Owes</Button
				>
			</div>
		</div>
	{/if}

	{#if emptyKind === 'filtered-empty'}
		<!-- Filtered-empty (task 8.1): the filter matched nothing → offer to clear
		     it (a real link back to the unfiltered list, no-JS friendly). -->
		<EmptyState
			icon={FilterXIcon}
			title="No transactions match these filters"
			description="Nothing here for the current filter. Try a different type, category or person, or clear the filter to see everything."
		>
			{#snippet action()}
				<!-- `filterUrl` returns a `resolve()`d path with an appended query string
				     (already a resolved URL); Button's `href` is the same link control the
				     filter buttons above use. -->
				<Button variant="outline" href={unfilteredUrl}>Clear filter</Button>
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
		<!-- One heading per day, rows beneath it. The heading is sticky so the day in
		     view is always identifiable while scrolling a long list. -->
		{#each dayGroups as group (group.key)}
			<section class="space-y-2">
				<h2
					class="sticky top-14 z-5 bg-background/95 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur supports-backdrop-filter:bg-background/80"
				>
					{group.label}
				</h2>
				<ul class="space-y-2">
					{#each group.items as txn (txn.id)}
						<li>
							<!-- Links to the per-transaction view/edit page (task 4.11). -->
							<a
								href={resolve('/groups/[id]/transactions/[txid]', {
									id: data.group.id,
									txid: txn.id
								})}
								class="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent"
							>
								<span
									class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
									aria-hidden="true"
								>
									<CategoryIcon name={txn.categoryIcon} class="size-5" />
								</span>
								<span class="min-w-0 flex-1">
									<span class="flex items-center gap-2">
										<span class="truncate font-medium">{txn.title}</span>
										<!-- Transfers only: a "spending" badge on every row was redundant
										     with the icon AND the filter chips above, and its width is what
										     truncated titles to "Museum tic…" at 390px. -->
										{#if txn.type === 'transfer'}
											<Badge variant="secondary" class="shrink-0">transfer</Badge>
										{/if}
									</span>
									<span class="block text-xs text-muted-foreground">
										{txn.categoryName}
									</span>
								</span>
								<!-- §7.6 display: show the ORIGINAL amount + currency; for a foreign
								     transaction the settlement equivalent is secondary text below.
								     Settlement-currency amounts drop the ISO code (the group states it
								     once); a foreign amount keeps it so the two can't be confused. -->
								<span class="shrink-0 text-right">
									<span class="block font-medium tabular-nums">
										{formatAmount(txn.amountTotal, txn.currency, { code: txn.isForeign })}
									</span>
									{#if txn.isForeign}
										<span class="block text-xs text-muted-foreground tabular-nums">
											{formatAmount(txn.amountTotalSettlement, settlementCurrency, {
												code: false
											})}
										</span>
									{/if}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</div>
