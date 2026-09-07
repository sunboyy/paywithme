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
	import type { SeededCurrencyCode } from '$lib/money';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import FormStatus from '$lib/components/FormStatus.svelte';
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
		settlementCurrency: data.group.settlementCurrency as SeededCurrencyCode,
		memberIds: data.members.map((m) => m.id),
		// The group's entry-currency set (PLAN §7.5.2) — the same list the picker
		// renders, so client validation accepts exactly what the server does (and
		// resolves a custom currency's exponent for the §7.6 conversion).
		entryCurrencies: data.currencies
	});

	// svelte-ignore state_referenced_locally
	const form = superForm(data.form, {
		dataType: 'json',
		validators: zod4Client(schema)
	});

	const { message } = form;

	/**
	 * Where the form posts. When this page is recording a note from the "Not recorded
	 * yet" tray (issue #51; PLAN §7.7), the `?capture=` id must ride along: the action
	 * reads it from its own query string to stamp the note in the same DB transaction
	 * as the insert. A form's `action` replaces the WHOLE query string, so it is
	 * spelled out here rather than left to the browser's default.
	 */
	const action = $derived(
		data.captureId ? `?capture=${encodeURIComponent(data.captureId)}` : undefined
	);
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
		<ArrowLeftIcon class="size-4" aria-hidden="true" />
		Back
	</Button>

	<Card.Root>
		<Card.Header>
			<Card.Title role="heading" aria-level={1} class="text-2xl">Add transaction</Card.Title>
			<Card.Description>{data.group.name}</Card.Description>
		</Card.Header>
		<Card.Content>
			<!-- Whole-form feedback: the §7.7 race where someone else already recorded or
			     discarded the note this form was opened from (nothing was saved). -->
			{#if $message}
				<div class="mb-4">
					<FormStatus message={$message} />
				</div>
			{/if}
			{#if data.members.length === 0}
				<p class="text-sm text-muted-foreground">
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
					{action}
				/>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
