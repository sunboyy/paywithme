<script lang="ts">
	// Display-name capture form (PLAN §5.3, #26), split into its own component so
	// `superForm` and its store destructuring live at the top level — the same
	// idiomatic pattern as `/register` (task 2.5). The parent only renders this
	// when there's a form to seed (authenticated user with an empty name), so the
	// `form` prop is always present here.
	import { superForm, type SuperValidated } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { displayNameSchema, type DisplayNameInput } from '$lib/schemas/auth';
	import * as Card from '$lib/components/ui/card';
	import * as Form from '$lib/components/ui/form';
	import { Input } from '$lib/components/ui/input';

	let {
		data,
		redirectTo = null
	}: { data: SuperValidated<DisplayNameInput>; redirectTo?: string | null } = $props();

	// Seed from the initial validated form; superForm syncs later updates
	// internally (the warning is a known false positive for this pattern).
	// svelte-ignore state_referenced_locally
	const form = superForm(data, {
		// Client validators mirror the server schema so errors surface inline when
		// JS is present; the server re-validates regardless (server-first).
		validators: zod4Client(displayNameSchema)
	});

	const { form: formData, message, submitting, enhance } = form;
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-2xl">What should we call you?</Card.Title>
		<Card.Description>
			You're almost in. Pick a display name — it's how you'll show up to others in your groups.
		</Card.Description>
	</Card.Header>

	<Card.Content>
		{#if $message?.type === 'error'}
			<p class="text-destructive mb-4 text-sm" role="alert">{$message.text}</p>
		{/if}

		<form method="POST" use:enhance class="space-y-4">
			<!-- Carry the sanitized final destination (task 3.7) through name capture. -->
			{#if redirectTo}
				<input type="hidden" name="redirectTo" value={redirectTo} />
			{/if}
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
				{$submitting ? 'Saving…' : 'Continue'}
			</Form.Button>
		</form>
	</Card.Content>
</Card.Root>
