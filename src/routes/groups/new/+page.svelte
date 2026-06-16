<script lang="ts">
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { createGroupSchema } from '$lib/schemas/group';
	import { CURRENCIES } from '$lib/money/currencies';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Capturing `data.form` once is intentional: superForm seeds from the initial
	// validated form and syncs later updates internally (mirrors /register).
	// svelte-ignore state_referenced_locally
	const form = superForm(data.form, {
		// Client validators mirror the server schema so errors surface inline when
		// JS is present; the server re-validates regardless (server-first).
		validators: zod4Client(createGroupSchema)
	});

	const { form: formData, message, submitting, enhance } = form;

	// Label shown in the Select trigger for the currently selected currency.
	const selectedLabel = $derived.by(() => {
		const code = $formData.settlementCurrency;
		const currency = CURRENCIES.find((c) => c.code === code);
		return currency ? `${currency.code} — ${currency.name} (${currency.symbol})` : undefined;
	});
</script>

<svelte:head>
	<title>New group · Pay with me</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-2xl">New group</Card.Title>
		<Card.Description>Name your group and pick the currency you'll settle up in.</Card.Description>
	</Card.Header>

	<Card.Content>
		{#if $message?.type === 'error'}
			<p class="text-destructive mb-4 text-sm" role="alert">{$message.text}</p>
		{/if}

		<form method="POST" use:enhance class="space-y-4">
			<Form.Field {form} name="name">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Group name</Form.Label>
						<Input
							{...props}
							type="text"
							placeholder="Trip to Chiang Mai"
							bind:value={$formData.name}
						/>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>

			<Form.Field {form} name="settlementCurrency">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Settlement currency</Form.Label>
						<Select.Root type="single" bind:value={$formData.settlementCurrency} name={props.name}>
							<Select.Trigger {...props} class="w-full">
								{selectedLabel ?? 'Select a currency'}
							</Select.Trigger>
							<Select.Content>
								{#each CURRENCIES as currency (currency.code)}
									<Select.Item value={currency.code} label={currency.code}>
										{currency.code} — {currency.name} ({currency.symbol})
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>

			<Form.Button class="w-full" disabled={$submitting}>
				{$submitting ? 'Creating…' : 'Create group'}
			</Form.Button>
		</form>
	</Card.Content>
</Card.Root>
