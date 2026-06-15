<script lang="ts">
	// `/onboarding/passkey` — nudge a freshly-signed-in user to enrol a passkey
	// (PLAN §5.3 step 4, §5.4/§5.5). Skippable: "Skip for now" is a real <a> so it
	// works without JS. Enrolment is WebAuthn (JS-only) — the same client passkey
	// pattern as task 2.7's login page.
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/auth-client';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';

	// Enrolment state. The button is a real <button type="button">; WebAuthn is
	// inherently JS-only, so this path simply does nothing without JS (the skip
	// link covers the no-JS case — skipping must not require JS).
	let enrolling = $state(false);
	let enrolError = $state<string | null>(null);

	async function addPasskey() {
		if (enrolling) return;
		enrolling = true;
		enrolError = null;

		try {
			// better-auth client returns `{ data, error }` — it does not throw for
			// the usual failures. On `error`, show friendly copy (never the raw
			// object). A user cancelling the OS WebAuthn prompt surfaces as an error
			// (or, in some browsers, a thrown exception) — treat that as a non-event
			// so we don't show scary copy (same approach as task 2.7's login handler).
			const { error } = await authClient.passkey.addPasskey();

			if (error) {
				enrolError = 'Could not add a passkey. Try again, or skip for now.';
				return;
			}

			// Credential stored against the user; continue into the app.
			await goto(resolve('/'));
		} catch {
			// Defensive: an unexpected thrown error (e.g. WebAuthn cancellation in
			// some browsers) should not crash the UI or leak details.
			enrolError = 'Could not add a passkey. Try again, or skip for now.';
		} finally {
			enrolling = false;
		}
	}
</script>

<svelte:head>
	<title>Add a passkey · Pay with me</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-2xl">Add a passkey</Card.Title>
		<Card.Description>
			Add a passkey for faster, password-free sign-in next time — no email link to wait for.
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-6">
		<p class="text-muted-foreground text-sm">
			Your device handles the rest with Face ID, a fingerprint, or your screen lock. You can add
			more passkeys later for your other devices.
		</p>

		<div class="space-y-3">
			{#if enrolError}
				<p class="text-destructive text-sm" role="alert">{enrolError}</p>
			{/if}
			<Button type="button" class="w-full" disabled={enrolling} onclick={addPasskey}>
				{enrolling ? 'Adding passkey…' : 'Add a passkey'}
			</Button>
		</div>
	</Card.Content>

	<Card.Footer>
		<a
			href={resolve('/')}
			class="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
		>
			Skip for now
		</a>
	</Card.Footer>
</Card.Root>
