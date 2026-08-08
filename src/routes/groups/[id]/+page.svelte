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
	import { formatAmount, type SeededCurrencyCode } from '$lib/money';
	import { actionLabel, absoluteTime, relativeTime } from '$lib/activity-labels';
	import { dayLabel } from '$lib/date-groups';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const settlementCurrency = $derived(data.group.settlementCurrency as SeededCurrencyCode);
</script>

<svelte:head>
	<title>{data.group.name} · Pay with me</title>
</svelte:head>

<!-- Single column on phones (the priority), two from `lg:` — where a 672px column
     centred in the shell left the right half of the window empty. The header spans
     both; money (your position + the per-member balances) takes the left rail, the
     feeds take the wider main column. -->
<div class="mx-auto w-full max-w-2xl space-y-4 lg:max-w-none">
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

	<div
		class="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start"
	>
		<div class="space-y-4">
			<!-- The viewer's OWN position, first thing on the page.

	     Previously the page opened with a neutral table of every member, in which
	     your own row was visually identical to the other three — so the one number
	     the page is opened to check ("do I owe anyone?") had to be hunted for.
	     The per-member list still follows below; this just answers the question
	     first. Colour is paired with the wording, never carrying it alone. -->
			{#if data.summary}
				{@const owed = data.summary.balance > 0}
				{@const settled = data.summary.balance === 0}
				<Card.Root class="gap-0 py-5">
					<Card.Content class="flex items-center justify-between gap-4 px-5">
						<div class="min-w-0">
							<p class="text-sm text-muted-foreground">
								{settled ? "You're all square" : owed ? 'You are owed' : 'You owe'}
							</p>
							{#if !settled}
								<p
									class="text-3xl font-semibold tabular-nums {owed
										? 'text-money-positive'
										: 'text-money-negative'}"
								>
									{data.summary.amountFormatted}
								</p>
								{#if data.summary.counterparties > 0}
									<p class="text-xs text-muted-foreground">
										{owed ? 'from' : 'to'}
										{data.summary.counterparties}
										{data.summary.counterparties === 1 ? 'person' : 'people'}
									</p>
								{/if}
							{:else}
								<p class="text-sm text-muted-foreground">Nothing to settle right now.</p>
							{/if}
						</div>
						{#if !settled}
							<Button
								variant="outline"
								class="shrink-0"
								href={resolve('/groups/[id]/settle', { id: data.group.id })}
							>
								Settle up
							</Button>
						{/if}
					</Card.Content>
				</Card.Root>
			{/if}

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
							class="text-sm text-muted-foreground hover:text-foreground hover:underline"
						>
							Settle up →
						</a>
					</Card.Action>
				</Card.Header>
				<Card.Content>
					{#if data.balances.length === 0}
						<p class="text-sm text-muted-foreground">No members yet.</p>
					{:else}
						<ul class="divide-y divide-border" aria-label="Member balances">
							{#each data.balances as row (row.memberId)}
								<li class="flex items-center justify-between gap-2 py-2">
									<span class="flex items-center gap-2">
										<span class="font-medium">{row.displayName}</span>
										{#if row.isYou}
											<Badge variant="outline">You</Badge>
										{/if}
										{#if row.isDebtor}
											<Badge variant="secondary">owes</Badge>
										{:else if row.isCreditor}
											<Badge variant="secondary">is owed</Badge>
										{:else}
											<Badge variant="outline">settled</Badge>
										{/if}
										{#if !row.isActive}
											<Badge variant="outline" class="text-muted-foreground">Inactive</Badge>
										{/if}
									</span>
									<!-- Semantic money colours, NOT --destructive: owing money is not an
							     error, and being owed had no positive encoding when the only signal
							     was red-vs-black. The adjacent badge carries the same meaning in
							     text, so colour is never the sole channel. -->
									<span
										class="shrink-0 font-medium tabular-nums {row.isDebtor
											? 'text-money-negative'
											: row.isCreditor
												? 'text-money-positive'
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
		</div>

		<div class="space-y-4">
			<!-- Recent transactions: last 5, with a "See all" link. -->
			<Card.Root>
				<Card.Header class="pb-2">
					<Card.Title>Recent transactions</Card.Title>
					<Card.Action>
						<a
							href={resolve('/groups/[id]/transactions', { id: data.group.id })}
							class="text-sm text-muted-foreground hover:text-foreground hover:underline"
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
										class="flex items-center gap-3 rounded-lg bg-card p-2 transition-colors hover:bg-accent"
									>
										<span
											class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
											aria-hidden="true"
										>
											<CategoryIcon name={txn.categoryIcon} class="size-4" />
										</span>
										<span class="min-w-0 flex-1">
											<span class="flex min-w-0 items-center gap-2">
												<span class="min-w-0 flex-1 truncate text-sm font-medium">{txn.title}</span>
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
											<span class="block text-xs text-muted-foreground">
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
							class="text-sm text-muted-foreground hover:text-foreground hover:underline"
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
						<!-- Two lines per entry, not three. Each row used to lead with
						     "{actor} created [Transaction]" and then repeat the amount in the
						     summary beneath — so the card cost as much height as the actual
						     transaction list while saying less. The summary line already names
						     what happened, so the actor + relative time ride above it and the
						     entity-type badge is dropped (it read "Transaction" on every row).
						     The full feed at /activity keeps the verbose form. -->
						<ul class="divide-y divide-border" aria-label="Recent activity">
							{#each data.recentActivity as entry (entry.id)}
								<li class="flex flex-col gap-0.5 py-2">
									<p class="text-sm">{entry.summary}</p>
									<p class="text-xs text-muted-foreground">
										<span class="font-medium">{entry.actorName}</span>
										{actionLabel(entry.action)} ·
										<time datetime={entry.occurredAt} title={absoluteTime(entry.occurredAt)}>
											{relativeTime(entry.occurredAt)}
										</time>
									</p>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	</div>
</div>
