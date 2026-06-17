<script lang="ts">
	// `/groups/[id]/transactions/new` — add a transaction (task 4.7).
	//
	// Thin page: it builds the client `superForm` from the SHARED
	// `buildTransactionSchema` (same factory as the server) and hands it to the
	// reusable <TransactionForm/>. The form posts to the `default` action and works
	// without JS; superForm `enhance` upgrades it (server-first, PE).
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
	import { buildTransactionSchema } from '$lib/schemas/transaction';
	import type { CurrencyCode } from '$lib/money';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import TransactionForm from '$lib/components/TransactionForm.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Client validators mirror the server schema (built from the same factory) so
	// errors surface inline when JS is present; the server re-validates regardless.
	// The schema is built once from the initial page data (it doesn't change after
	// hydration) — capturing the initial `data` here is intentional.
	// svelte-ignore state_referenced_locally
	const schema = buildTransactionSchema({
		settlementCurrency: data.group.settlementCurrency as CurrencyCode,
		memberIds: data.members.map((m) => m.id)
	});

	// svelte-ignore state_referenced_locally
	const form = superForm(data.form, {
		dataType: 'json',
		validators: zod4Client(schema)
	});
</script>

<svelte:head>
	<title>Add transaction · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-lg space-y-4">
	<Button
		variant="ghost"
		size="sm"
		href={resolve('/groups/[id]/transactions', { id: data.group.id })}
		class="gap-1"
	>
		<ArrowLeftIcon class="size-4" />
		Back
	</Button>

	<Card.Root>
		<Card.Header>
			<Card.Title class="text-2xl">Add transaction</Card.Title>
			<Card.Description>{data.group.name}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.members.length === 0}
				<p class="text-muted-foreground text-sm">
					Add members to this group before recording a transaction.
				</p>
			{:else}
				<TransactionForm
					{form}
					members={data.members}
					categories={data.categories}
					currency={data.currency}
					currencies={data.currencies}
					submitLabel="Add transaction"
				/>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
