<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { buttonVariants } from '$lib/components/ui/button';
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
		<ul class="space-y-3">
			{#each data.groups as group (group.id)}
				<li>
					<!-- Cards show name + settlement currency only. Net balances are
					     Phase 5 (task 5.1) and are intentionally NOT shown here. -->
					<Card.Root>
						<Card.Header class="flex-row items-center justify-between gap-4 space-y-0">
							<Card.Title class="text-lg wrap-break-word">{group.name}</Card.Title>
							<Badge variant="secondary">{currencyLabel(group.settlementCurrency)}</Badge>
						</Card.Header>
					</Card.Root>
				</li>
			{/each}
		</ul>
	{:else}
		<!-- Empty state (clean + clear; full polish is task 8.1). -->
		<Card.Root>
			<Card.Header class="text-center">
				<Card.Title class="text-xl">No groups yet</Card.Title>
				<Card.Description>
					Create a group to start splitting spending and settling up with friends.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex justify-center">
				<a href={resolve('/groups/new')} class={buttonVariants({ variant: 'default' })}>
					Create your first group
				</a>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
