<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { createGroupSchema } from '$lib/schemas/group';
	import { CURRENCIES } from '$lib/money/currencies';
	import { cn } from '$lib/utils';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
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

	// Label shown in the combobox trigger for the currently selected currency.
	const selectedLabel = $derived.by(() => {
		const code = $formData.settlementCurrency;
		const currency = CURRENCIES.find((c) => c.code === code);
		return currency ? `${currency.code} — ${currency.name} (${currency.symbol})` : undefined;
	});

	// Progressive enhancement: the searchable combobox (Popover + Command) is
	// inherently JS-only, so we render a plain native <select> for SSR / no-JS and
	// swap to the combobox after hydration. Both post `settlementCurrency`; only one
	// is in the DOM at a time (no double-submit). The schema default (THB) means the
	// field has a valid value even when JS never runs.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	// Combobox open state + a ref so selecting an item returns focus to the trigger.
	let comboOpen = $state(false);
	let triggerRef = $state<HTMLButtonElement | null>(null);

	function selectCurrency(code: string) {
		$formData.settlementCurrency = code;
		comboOpen = false;
		tick().then(() => triggerRef?.focus());
	}
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
						{#if mounted}
							<!-- Searchable combobox (JS): type to filter by code, name or symbol. -->
							<input type="hidden" name={props.name} value={$formData.settlementCurrency} />
							<Popover.Root bind:open={comboOpen}>
								<Popover.Trigger bind:ref={triggerRef}>
									{#snippet child({ props: triggerProps })}
										<Button
											{...props}
											{...triggerProps}
											variant="outline"
											role="combobox"
											aria-expanded={comboOpen}
											class="w-full justify-between font-normal"
										>
											<span class={cn(!selectedLabel && 'text-muted-foreground')}>
												{selectedLabel ?? 'Select a currency'}
											</span>
											<ChevronsUpDownIcon class="opacity-50" />
										</Button>
									{/snippet}
								</Popover.Trigger>
								<Popover.Content class="w-(--bits-floating-anchor-width) p-0">
									<Command.Root>
										<Command.Input placeholder="Search currency…" />
										<Command.List>
											<Command.Empty>No currency found.</Command.Empty>
											<Command.Group>
												{#each CURRENCIES as currency (currency.code)}
													<Command.Item
														value={currency.code}
														keywords={[currency.name, currency.symbol]}
														onSelect={() => selectCurrency(currency.code)}
													>
														<CheckIcon
															class={cn(
																$formData.settlementCurrency !== currency.code && 'text-transparent'
															)}
														/>
														{currency.code} — {currency.name} ({currency.symbol})
													</Command.Item>
												{/each}
											</Command.Group>
										</Command.List>
									</Command.Root>
								</Popover.Content>
							</Popover.Root>
						{:else}
							<!-- No-JS / pre-hydration fallback: a native select (server-first). -->
							<select
								{...props}
								bind:value={$formData.settlementCurrency}
								class="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
							>
								{#each CURRENCIES as currency (currency.code)}
									<option value={currency.code}>
										{currency.code} — {currency.name} ({currency.symbol})
									</option>
								{/each}
							</select>
						{/if}
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
