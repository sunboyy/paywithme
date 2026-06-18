<script lang="ts">
	// `/groups/[id]/settle` — debt summary + settlement suggestions (task 5.4;
	// PLAN §8, §8.2, §8.4, §10).
	//
	// Mobile-first, server-first read-only page. Two sections:
	//   1. "Who should pay" (§8.2): every member ordered most-negative-first with a
	//      signed settlement-currency amount — surfaced prominently at the top.
	//   2. Suggested settlements (§8.3): each "{debtor} pays {creditor} {amount}"
	//      row has a "Settle up" link that PREFILLS a Transfer at
	//      `/groups/[id]/transactions/new` (payer = debtor, recipient = creditor,
	//      category = Debt settlement). On save it's a normal transaction (§8.4).
	//
	// shadcn-svelte components are used from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored / edited here). Mirrors the transactions / members pages.
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const newPath = $derived(resolve('/groups/[id]/transactions/new', { id: data.group.id }));

	/**
	 * Build the §8.4 "Settle up" prefill link for a suggestion: the add-transaction
	 * page seeded as a Transfer (payer = debtor, recipient = creditor, the settlement
	 * amount, category = Debt settlement). The amount is already in MINOR UNITS (no
	 * float parsing). Mirrors `transactions/+page.svelte`'s `filterUrl`: a `resolve()`d
	 * path with a manually-appended query string (the eslint-disable is at the
	 * navigation call site, the <a href>, below).
	 */
	function settleUrl(s: { fromMemberId: string; toMemberId: string; amount: number }): string {
		const params = [
			'type=transfer',
			`from=${encodeURIComponent(s.fromMemberId)}`,
			`to=${encodeURIComponent(s.toMemberId)}`,
			`amount=${s.amount}`,
			'category=transfer-debt-settlement'
		];
		return `${newPath}?${params.join('&')}`;
	}
</script>

<svelte:head>
	<title>Settle up · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<div class="flex items-center justify-between gap-2">
		<div>
			<h1 class="text-2xl font-semibold">Settle up</h1>
			<a
				href={resolve('/groups/[id]/transactions', { id: data.group.id })}
				class="text-muted-foreground text-sm hover:underline"
			>
				{data.group.name} · Transactions
			</a>
		</div>
	</div>

	<!-- §8.2 "Who should pay": balances ordered most-negative-first, surfaced
	     prominently. Signed settlement-currency amounts; debtors highlighted. -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Balances</Card.Title>
			<Card.Description>
				Who owes and who is owed, in {data.group.settlementCurrency}. The biggest debt is at the
				top.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<ul class="divide-border divide-y" aria-label="Member balances">
				{#each data.balances as row (row.memberId)}
					<li class="flex items-center justify-between gap-2 py-3">
						<span class="flex items-center gap-2">
							<span class="font-medium">{row.displayName}</span>
							{#if row.isDebtor}
								<Badge variant="destructive">owes</Badge>
							{:else if row.isCreditor}
								<Badge variant="secondary">is owed</Badge>
							{:else}
								<Badge variant="outline">settled</Badge>
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
		</Card.Content>
	</Card.Root>

	<!-- §8.3/§8.4 Suggested settlements: minimal set of transfers. Each row prefills
	     a Transfer at the add page. Empty state = all settled up. -->
	{#if data.allSettled}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-2 py-10 text-center">
				<CheckCircle2Icon class="text-muted-foreground size-8" />
				<p class="text-sm font-medium">All settled up</p>
				<p class="text-muted-foreground text-sm">
					Everyone's square — there's nothing to settle right now.
				</p>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Suggested settlements</Card.Title>
				<Card.Description>
					The fewest transfers to square everyone up. Tap "Settle up" to record one as a transfer.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<ul class="space-y-2" aria-label="Suggested settlements">
					{#each data.suggestions as s (s.fromMemberId + '→' + s.toMemberId)}
						<li
							class="bg-card flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
						>
							<span class="flex min-w-0 flex-1 items-center gap-2">
								<HandshakeIcon class="text-muted-foreground size-5 shrink-0" />
								<span class="min-w-0">
									<span class="flex flex-wrap items-center gap-1.5 font-medium">
										<span class="truncate">{s.fromDisplayName}</span>
										<ArrowRightIcon class="text-muted-foreground size-4 shrink-0" />
										<span class="truncate">{s.toDisplayName}</span>
									</span>
									<span class="text-muted-foreground block text-sm tabular-nums">
										{s.amountFormatted}
									</span>
								</span>
							</span>
							<!-- §8.4: prefill a Transfer (payer=debtor, recipient=creditor, amount,
							     category=Debt settlement). The href is a `resolve()`d path with an
							     appended query string (already a resolved URL). -->
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
							<a href={settleUrl(s)} class={buttonVariants({ size: 'sm' }) + ' shrink-0'}>
								Settle up
							</a>
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	{/if}

	<div>
		<Button href={resolve('/groups/[id]/transactions', { id: data.group.id })} variant="outline">
			Back to transactions
		</Button>
	</div>
</div>
