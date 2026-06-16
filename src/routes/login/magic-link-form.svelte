<script lang="ts">
	// Email magic-link fallback form (PLAN §5.5, §5.3), split into its own
	// component so `superForm` and its store destructuring live at the top level —
	// the same idiomatic pattern as `/register` (2.5) and `/auth/magic-link` (2.6),
	// which keeps the `svelte/no-inner-declarations`-style lint and the
	// `state_referenced_locally` warning contained to one place.
	import { superForm, type SuperValidated } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { loginSchema, type LoginInput } from '$lib/schemas/auth';
	import * as Form from '$lib/components/ui/form';
	import { Input } from '$lib/components/ui/input';

	let {
		data,
		redirectTo = null
	}: { data: SuperValidated<LoginInput>; redirectTo?: string | null } = $props();

	// Seed from the initial validated form; superForm syncs later updates
	// internally (the warning is a known false positive for this pattern).
	// svelte-ignore state_referenced_locally
	const form = superForm(data, {
		// Client validators mirror the server schema so errors surface inline when
		// JS is present; the server re-validates regardless (server-first).
		validators: zod4Client(loginSchema)
	});

	const { form: formData, message, submitting, enhance } = form;

	const sent = $derived($message?.type === 'sent');
</script>

{#if sent}
	<!-- Success confirmation (same UX whether or not the account existed — §12). -->
	<div class="space-y-3" role="status" aria-live="polite">
		<p class="font-medium">Check your email for a sign-in link</p>
		<p class="text-muted-foreground text-sm">
			We sent a single-use sign-in link to <strong class="break-all">{$message?.text}</strong>. Open
			it on this device to finish signing in. The link expires soon.
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
		<!-- Carry the sanitized post-auth destination (task 3.7) so the magic-link
		     callbackURL forwards there. Server re-sanitizes; empty/absent = default. -->
		{#if redirectTo}
			<input type="hidden" name="redirectTo" value={redirectTo} />
		{/if}
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

		<Form.Button class="w-full" disabled={$submitting}>
			{$submitting ? 'Sending…' : 'Email me a sign-in link'}
		</Form.Button>
	</form>
{/if}
