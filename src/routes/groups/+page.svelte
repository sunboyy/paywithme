<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { buttonVariants } from '$lib/components/ui/button';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { getCurrency } from '$lib/money/currencies';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const hasGroups = $derived(data.groups.length > 0);

	/** Display label for the settlement-currency badge, e.g. "฿ THB". */
	function currencyLabel(code: string): string {
		const currency = getCurrency(code);
		return currency ? `${currency.symbol} ${currency.code}` : code;
	}
</script>

<svelte:head>
	<title>Groups · Pay with me</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between gap-4">
		<h1 class="text-2xl font-bold">Groups</h1>
		{#if hasGroups}
			<a href={resolve('/groups/new')} class={buttonVariants({ variant: 'default' })}>New group</a>
		{/if}
	</div>

	{#if hasGroups}
		<!-- Two-up from `md:`: these cards are two short lines each, so a single
		     column past ~700px is mostly empty space. -->
		<ul class="grid gap-3 md:grid-cols-2">
			{#each data.groups as group (group.id)}
				<li>
					<!-- The card leads with the caller's OWN position, which is what the
					     dashboard is opened to check. The settlement currency alone (the
					     card's previous content) answered a question nobody has — and the
					     formatted amount already carries the symbol, so the currency badge
					     only earns its place when there is no figure to show. -->
					<a
						href={resolve('/groups/[id]', { id: group.id })}
						class="focus-visible:ring-ring block rounded-xl focus-visible:ring-2 focus-visible:outline-none"
					>
						<Card.Root class="hover:bg-accent/50 gap-0 py-4 transition-colors">
							<Card.Header class="px-4">
								<Card.Title class="text-base wrap-break-word">{group.name}</Card.Title>
								<Card.Action>
									{#if group.net === null}
										<Badge variant="secondary">{currencyLabel(group.settlementCurrency)}</Badge>
									{:else if group.net === 0}
										<span class="text-muted-foreground text-sm">settled up</span>
									{:else}
										<span class="text-right">
											<span class="text-muted-foreground block text-xs">
												{group.net > 0 ? 'you are owed' : 'you owe'}
											</span>
											<span
												class="block font-semibold tabular-nums {group.net > 0
													? 'text-money-positive'
													: 'text-money-negative'}"
											>
												{group.netFormatted}
											</span>
										</span>
									{/if}
								</Card.Action>
							</Card.Header>
						</Card.Root>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<!-- Nothing-yet empty state (task 8.1): the shared EmptyState with the
		     obvious create CTA as a real link (progressive enhancement). -->
		<EmptyState
			icon={UsersIcon}
			title="No groups yet"
			description="Create a group to start splitting spending and settling up with friends."
		>
			{#snippet action()}
				<a href={resolve('/groups/new')} class={buttonVariants({ variant: 'default' })}>
					Create your first group
				</a>
			{/snippet}
		</EmptyState>
	{/if}
</div>
