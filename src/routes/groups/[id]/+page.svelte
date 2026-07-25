<script lang="ts">
	// `/groups/[id]` — group overview / home page.
	//
	// Three summary sections:
	//   1. Balance summary — who owes / who is owed (ordered most-negative first).
	//   2. Recent transactions — the 5 newest, with a "See all" link.
	//   3. Recent activity — the 5 newest audit entries, with a "See all" link.
	//
	// Mobile-first, server-first. No filters here — the full list pages carry those.
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import CategoryIcon from '$lib/components/CategoryIcon.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import GroupNav from '$lib/components/GroupNav.svelte';
	import { formatAmount, type CurrencyCode } from '$lib/money';
	import { actionLabel, absoluteTime, relativeTime } from '$lib/activity-labels';
	import { dayLabel } from '$lib/date-groups';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const settlementCurrency = $derived(data.group.settlementCurrency as CurrencyCode);
</script>

<svelte:head>
	<title>{data.group.name} · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<header class="space-y-3">
		<div class="flex items-center justify-between gap-3">
			<h1 class="truncate text-2xl font-semibold tracking-tight">{data.group.name}</h1>
			<Button
				href={resolve('/groups/[id]/transactions/new', { id: data.group.id })}
				class="shrink-0 gap-1"
			>
				<PlusIcon class="size-4" aria-hidden="true" />
				Add
			</Button>
		</div>
		<GroupNav groupId={data.group.id} current="overview" />
	</header>

	<!-- Balance summary: who owes / who is owed. Links to the full settle page.

	     The trailing link goes in <Card.Action>, NOT a `flex-row justify-between`
	     class on <Card.Header>: the header is `display: grid`, and since `cn()`
	     (tailwind-merge) treats `display` and `flex-direction` as different groups
	     it keeps both — `grid` wins and the `flex-row` override is silently inert,
	     which dropped the link onto its own line. `data-slot="card-action"` is what
	     switches the header to `grid-cols-[1fr_auto]`. -->
	<Card.Root>
		<Card.Header class="pb-2">
			<Card.Title>Balances</Card.Title>
			<Card.Action>
				<a
					href={resolve('/groups/[id]/settle', { id: data.group.id })}
					class="text-muted-foreground hover:text-foreground text-sm hover:underline"
				>
					Settle up →
				</a>
			</Card.Action>
		</Card.Header>
		<Card.Content>
			{#if data.balances.length === 0}
				<p class="text-muted-foreground text-sm">No members yet.</p>
			{:else}
				<ul class="divide-border divide-y" aria-label="Member balances">
					{#each data.balances as row (row.memberId)}
						<li class="flex items-center justify-between gap-2 py-2">
							<span class="flex items-center gap-2">
								<span class="font-medium">{row.displayName}</span>
								{#if row.isDebtor}
									<Badge variant="destructive">owes</Badge>
								{:else if row.isCreditor}
									<Badge variant="secondary">is owed</Badge>
								{:else}
									<Badge variant="outline">settled</Badge>
								{/if}
								{#if !row.isActive}
									<Badge variant="outline" class="text-muted-foreground">Inactive</Badge>
								{/if}
							</span>
							<span
								class="shrink-0 font-medium tabular-nums {row.isDebtor
									? 'text-destructive'
									: row.isCreditor
										? ''
										: 'text-muted-foreground'}"
							>
								{row.balanceFormatted}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Recent transactions: last 5, with a "See all" link. -->
	<Card.Root>
		<Card.Header class="pb-2">
			<Card.Title>Recent transactions</Card.Title>
			<Card.Action>
				<a
					href={resolve('/groups/[id]/transactions', { id: data.group.id })}
					class="text-muted-foreground hover:text-foreground text-sm hover:underline"
				>
					See all →
				</a>
			</Card.Action>
		</Card.Header>
		<Card.Content>
			{#if data.recentTransactions.length === 0}
				<EmptyState
					icon={ReceiptIcon}
					title="No transactions yet"
					description="Add your first transaction to start splitting costs."
				>
					{#snippet action()}
						<a
							href={resolve('/groups/[id]/transactions/new', { id: data.group.id })}
							class={buttonVariants({ variant: 'default', size: 'sm' })}
						>
							Add transaction
						</a>
					{/snippet}
				</EmptyState>
			{:else}
				<ul class="space-y-1" aria-label="Recent transactions">
					{#each data.recentTransactions as txn (txn.id)}
						<li>
							<a
								href={resolve('/groups/[id]/transactions/[txid]', {
									id: data.group.id,
									txid: txn.id
								})}
								class="bg-card hover:bg-accent flex items-center gap-3 rounded-lg p-2 transition-colors"
							>
								<span
									class="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full"
									aria-hidden="true"
								>
									<CategoryIcon name={txn.categoryIcon} class="size-4" />
								</span>
								<span class="min-w-0 flex-1">
									<span class="flex items-center gap-2">
										<span class="truncate text-sm font-medium">{txn.title}</span>
										<!-- Only TRANSFERS are badged. A "spending" badge on every row said
										     nothing (the category icon already encodes it) while eating the
										     width that truncated titles to "Museum t…" on a phone. -->
										{#if txn.type === 'transfer'}
											<Badge variant="secondary" class="shrink-0 text-xs">transfer</Badge>
										{/if}
									</span>
									<!-- `created_at` is the user-editable REAL-WORLD DATE (day precision, from
									     a `type="date"` input), NOT an insert timestamp — so it gets a day
									     label. A fine-grained relative time reads as nonsense here ("in 17
									     minutes") for anything dated today. The audit rows below use
									     `occurred_at`, which IS a true timestamp, and keep relativeTime. -->
									<span class="text-muted-foreground block text-xs">
										{dayLabel(txn.createdAt)}
									</span>
								</span>
								<span class="shrink-0 text-right">
									<!-- Settlement-currency amounts render bare ("¥3,200"); a FOREIGN amount
									     keeps its ISO code so the two are never confusable. -->
									<span class="block text-sm font-medium tabular-nums">
										{formatAmount(txn.amountTotal, txn.currency, { code: txn.isForeign })}
									</span>
									{#if txn.isForeign}
										<span class="text-muted-foreground block text-xs tabular-nums">
											{formatAmount(txn.amountTotalSettlement, settlementCurrency, { code: false })}
										</span>
									{/if}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Recent activity: last 5 audit entries, with a "See all" link. -->
	<Card.Root>
		<Card.Header class="pb-2">
			<Card.Title>Recent activity</Card.Title>
			<Card.Action>
				<a
					href={resolve('/groups/[id]/activity', { id: data.group.id })}
					class="text-muted-foreground hover:text-foreground text-sm hover:underline"
				>
					See all →
				</a>
			</Card.Action>
		</Card.Header>
		<Card.Content>
			{#if data.recentActivity.length === 0}
				<EmptyState
					icon={HandshakeIcon}
					title="No activity yet"
					description="Actions in this group will appear here."
				/>
			{:else}
				<ul class="divide-border divide-y" aria-label="Recent activity">
					{#each data.recentActivity as entry (entry.id)}
						<li class="flex flex-col gap-0.5 py-2">
							<div class="flex items-start justify-between gap-2">
								<p class="min-w-0 text-sm">
									<span class="font-medium">{entry.actorName}</span>
									<span class="text-muted-foreground"> {actionLabel(entry.action)} </span>
									<Badge variant="outline" class="ml-1 align-middle text-xs capitalize">
										{entry.entityType}
									</Badge>
								</p>
								<time
									datetime={entry.occurredAt}
									title={absoluteTime(entry.occurredAt)}
									class="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
								>
									{relativeTime(entry.occurredAt)}
								</time>
							</div>
							<p class="text-muted-foreground text-xs">{entry.summary}</p>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
