<script lang="ts">
	// `/settings/api-keys/new` — the create-key screen (PLAN §16.8).
	//
	// SERVER-FIRST, FULLY PROGRESSIVE. Everything on this page is plain HTML that
	// posts to the route's `default` action: a text input, NATIVE radio inputs for
	// the scope cards and the expiry presets, and a number input for a custom TTL.
	// With JS off it submits, validates, mints, and redirects to the reveal screen
	// exactly the same way — `superForm` only layers inline error messages on top.
	//
	// WHY NATIVE RADIOS (and not a `RadioGroup` component): bits-ui's radio group
	// renders <button>s driven by JS, so with JS disabled nothing would be selected
	// and no value would be submitted. The whole point of §16.8's "works with JS
	// disabled" is that scope — the money-safety choice — must survive that. So the
	// radio-CARD look is achieved with a real `<input type="radio">` inside a styled
	// <label>, which is keyboard- and screen-reader-native for free.
	//
	// The custom-days input is only shown when "Custom" is checked — but via a CSS
	// `:has()` rule, NOT `{#if expiry === 'custom'}`. A no-JS page can't re-render on
	// a radio change, so an `{#if}` field could never appear; `:has()` reacts to
	// `:checked` in the browser's own style engine, so it works with JS disabled.
	// The field stays in the DOM and still submits when hidden — harmless, because
	// the schema ignores `customDays` unless "Custom" is the chosen expiry.
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
	import {
		createApiKeySchema,
		API_KEY_CUSTOM_EXPIRY_MAX_DAYS,
		API_KEY_CUSTOM_EXPIRY_MIN_DAYS,
		API_KEY_NAME_MAX_LENGTH
	} from '$lib/schemas/api-key';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// svelte-ignore state_referenced_locally
	const form = superForm(data.form, {
		// Mirror the server schema so errors surface inline when JS is present; the
		// server re-validates every submission regardless (server-first).
		validators: zod4Client(createApiKeySchema)
	});
	const { form: formData, message, submitting, enhance } = form;

	// The two scope cards (PLAN §16.2/§16.8) — the money-safety difference is
	// spelled out inline, because this is the single most consequential choice on
	// the page: a leaked or prompt-injected READ key physically cannot move money.
	const scopeOptions = [
		{
			value: 'read' as const,
			label: 'Read only',
			icon: EyeIcon,
			summary: 'View groups, transactions, members, and balances.',
			safety: 'Cannot create, edit, or delete anything — it can never move money.'
		},
		{
			value: 'write' as const,
			label: 'Read & write',
			icon: PencilIcon,
			summary: 'Everything a read key can do, plus record and settle transactions.',
			safety: 'Can move money on your behalf. Only give this to tools you trust.'
		}
	];

	const expiryOptions = [
		{ value: 'never' as const, label: 'Never', hint: 'Recommended for long-lived tools' },
		{ value: '30' as const, label: '30 days', hint: null },
		{ value: '90' as const, label: '90 days', hint: null },
		{ value: '365' as const, label: '365 days', hint: null },
		{ value: 'custom' as const, label: 'Custom', hint: 'Set the number of days below' }
	];
</script>

<svelte:head>
	<title>Create an API key · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold tracking-tight">Create an API key</h1>
		<p class="text-muted-foreground text-sm">
			An API key lets a script or an AI agent act on your behalf — it sees exactly the groups you
			see. You'll see the key once, right after you create it.
		</p>
	</div>

	{#if $message?.type === 'error'}
		<p class="text-destructive text-sm" role="alert">{$message.text}</p>
	{/if}

	<form method="POST" use:enhance class="space-y-6">
		<Card.Root>
			<Card.Header>
				<Card.Title>Name</Card.Title>
				<Card.Description
					>So you can recognize this key later — and revoke the right one.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<Form.Field {form} name="name">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>Key name</Form.Label>
							<Input
								{...props}
								type="text"
								maxlength={API_KEY_NAME_MAX_LENGTH}
								placeholder="e.g. My budgeting agent"
								bind:value={$formData.name}
							/>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>
			</Card.Content>
		</Card.Root>

		<!-- Scope radio CARDS (PLAN §16.8). A real fieldset/legend, so a screen
		     reader announces "Access, Read only, 1 of 2". -->
		<Card.Root>
			<Card.Header>
				<Card.Title>Access</Card.Title>
				<Card.Description
					>What this key is allowed to do. You can't change it later.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<Form.Fieldset {form} name="scope" class="space-y-3">
					<Form.Legend class="sr-only">Access</Form.Legend>
					<div class="grid gap-3 sm:grid-cols-2">
						{#each scopeOptions as option (option.value)}
							{@const Icon = option.icon}
							<label
								class="border-input has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-ring flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors has-focus-visible:ring-2"
							>
								<input
									type="radio"
									name="scope"
									value={option.value}
									bind:group={$formData.scope}
									class="accent-primary mt-1 size-4 shrink-0"
								/>
								<span class="min-w-0 space-y-1">
									<span class="flex items-center gap-2 font-medium">
										<Icon class="size-4 shrink-0" aria-hidden="true" />
										{option.label}
									</span>
									<span class="text-muted-foreground block text-sm">{option.summary}</span>
									<span
										class="block text-sm font-medium {option.value === 'write'
											? 'text-destructive'
											: 'text-foreground'}"
									>
										{option.safety}
									</span>
								</span>
							</label>
						{/each}
					</div>
					<Form.FieldErrors />
				</Form.Fieldset>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Expiry</Card.Title>
				<Card.Description>
					Keys never expire by default. Give a key an end date if it's for a one-off job.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<!-- A plain div (not `Card.Content` itself) carries `expiry-group`: Svelte's
				     CSS scoping only hashes elements in THIS component's markup, so a class
				     handed to a child component would never match the scoped rule below. -->
				<div class="expiry-group space-y-4">
					<Form.Fieldset {form} name="expiry" class="space-y-3">
						<Form.Legend class="sr-only">Expiry</Form.Legend>
						<div class="grid gap-2 sm:grid-cols-2">
							{#each expiryOptions as option (option.value)}
								<label
									class="border-input has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-ring flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-2"
								>
									<input
										type="radio"
										name="expiry"
										value={option.value}
										bind:group={$formData.expiry}
										class="accent-primary mt-0.5 size-4 shrink-0"
									/>
									<span class="min-w-0">
										<span class="block font-medium">{option.label}</span>
										{#if option.hint}
											<span class="text-muted-foreground block text-xs">{option.hint}</span>
										{/if}
									</span>
								</label>
							{/each}
						</div>
						<Form.FieldErrors />
					</Form.Fieldset>

					<!-- Kept in the DOM and revealed by CSS when "Custom" is checked — see the
				     no-JS note in the module comment. -->
					<div class="custom-days">
						<Form.Field {form} name="customDays">
							<Form.Control>
								{#snippet children({ props })}
									<Form.Label>Custom expiry (days)</Form.Label>
									<Input
										{...props}
										type="number"
										inputmode="numeric"
										min={API_KEY_CUSTOM_EXPIRY_MIN_DAYS}
										max={API_KEY_CUSTOM_EXPIRY_MAX_DAYS}
										step="1"
										placeholder="e.g. 14"
										bind:value={$formData.customDays}
									/>
								{/snippet}
							</Form.Control>
							<Form.Description>
								How long this key should last — between {API_KEY_CUSTOM_EXPIRY_MIN_DAYS} and {API_KEY_CUSTOM_EXPIRY_MAX_DAYS}
								days.
							</Form.Description>
							<Form.FieldErrors />
						</Form.Field>
					</div>
				</div>
			</Card.Content>
		</Card.Root>

		<div class="flex flex-col gap-3 sm:flex-row-reverse">
			<Form.Button class="w-full sm:w-auto" disabled={$submitting}>
				{$submitting ? 'Creating key…' : 'Create key'}
			</Form.Button>
			<Button variant="outline" href={resolve('/settings')} class="w-full sm:w-auto">Cancel</Button>
			<!-- `/docs/api` is delivered by PLAN §16.9 (a separate ticket), so it is not
			     yet a known route id and `resolve()` cannot type it. A plain href is
			     correct and forward-compatible — it will resolve the moment that route
			     lands, and until then it 404s rather than silently disappearing. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<Button variant="ghost" href="/docs/api" class="w-full sm:mr-auto sm:w-auto">
				<BookOpenIcon class="size-4" aria-hidden="true" />
				View API docs
			</Button>
		</div>
	</form>
</div>

<style>
	/* The custom-days reveal. `:has()` + `:checked` is evaluated by the browser's
	   style engine, so this is the one way to make the field appear on a radio
	   change WITHOUT JavaScript — which §16.8 requires. `display: none` also takes
	   the input out of the tab order while hidden, so keyboard users don't land on
	   a field they can't see. */
	.custom-days {
		display: none;
	}

	.expiry-group:has(input[name='expiry'][value='custom']:checked) .custom-days {
		display: block;
	}
</style>
