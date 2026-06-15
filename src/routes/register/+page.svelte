<script lang="ts">
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { registerSchema } from '$lib/schemas/auth';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import { Input } from '$lib/components/ui/input';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// `message` shape is the global `App.Superforms.Message` (see app.d.ts):
	// `{ type: 'sent' | 'error'; text }`, set by the server action.
	// Capturing `data.form` once is intentional: superForm seeds from the initial
	// validated form and syncs later updates internally (the warning is a known
	// false positive for this pattern).
	// svelte-ignore state_referenced_locally
	const form = superForm(data.form, {
		// Client-side validators mirror the server schema so errors surface inline
		// when JS is present; the server re-validates regardless (server-first).
		validators: zod4Client(registerSchema)
	});

	const { form: formData, message, submitting, enhance } = form;

	const sent = $derived($message?.type === 'sent');
</script>

<svelte:head>
	<title>Register · Pay with me</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-2xl">Create your account</Card.Title>
		<Card.Description>
			Enter your email and a display name. We'll email you a single-use link to sign in — no
			password needed.
		</Card.Description>
	</Card.Header>

	<Card.Content>
		{#if sent}
			<!-- Success confirmation (same UX whether or not the account existed). -->
			<div class="space-y-3" role="status" aria-live="polite">
				<p class="font-medium">Check your email for a sign-in link</p>
				<p class="text-muted-foreground text-sm">
					We sent a single-use sign-in link to <strong class="break-all">{$message?.text}</strong>.
					Open it on this device to finish signing in. The link expires soon.
				</p>
				<p class="text-muted-foreground text-xs">
					In local development, the link is logged to the server console instead of being emailed.
				</p>
			</div>
		{:else}
			{#if $message?.type === 'error'}
				<p class="text-destructive mb-4 text-sm" role="alert">{$message.text}</p>
			{/if}

			<form method="POST" use:enhance class="space-y-4">
				<Form.Field {form} name="email">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>Email</Form.Label>
							<Input
								{...props}
								type="email"
								autocomplete="email"
								inputmode="email"
								placeholder="you@example.com"
								bind:value={$formData.email}
							/>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>

				<Form.Field {form} name="name">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>Display name</Form.Label>
							<Input
								{...props}
								type="text"
								autocomplete="name"
								placeholder="Alex Doe"
								bind:value={$formData.name}
							/>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>

				<Form.Button class="w-full" disabled={$submitting}>
					{$submitting ? 'Sending…' : 'Send sign-in link'}
				</Form.Button>
			</form>
		{/if}
	</Card.Content>

	<Card.Footer>
		<p class="text-muted-foreground text-sm">
			Already have an account?
			<!--
				Forward reference to the `/login` route built in task 2.7. It is not a
				known route yet, so `resolve('/login')` would not typecheck; the raw
				href is intentional until 2.7 lands.
			-->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a href="/login" class="text-foreground font-medium underline underline-offset-4">Sign in</a>
		</p>
	</Card.Footer>
</Card.Root>
