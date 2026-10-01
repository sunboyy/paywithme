<script lang="ts">
	// `/oauth/login` — the dedicated sign-in for the Claude.ai (MCP OAuth connector)
	// authorization flow. Reached only from the OAuth authorize endpoint
	// (`mcp({ loginPage: '/oauth/login' })`); the load redirects here-without-an-
	// OAuth-request back to the normal `/login`.
	//
	// The page never resumes the authorization itself. After a successful sign-in
	// it RELOADS (a full-page navigation to `continueTo`, this page's own URL), and
	// the server `load` resumes only if the session satisfies the request
	// (`prompt=login` / `max_age`). A cancelled passkey prompt therefore can't let
	// an older session through: it shows an error and stays here.
	import { authClient } from '$lib/auth-client';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	// Shared with `/login` (kept in that route so `/login` stays untouched).
	import MagicLinkForm from '../../login/magic-link-form.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// This page, with the signed OAuth request intact. Server-built local path.
	const continueTo = $derived(data.continueTo);

	let signingIn = $state(false);
	let passkeyError = $state<string | null>(null);
	const PASSKEY_ERROR = 'Could not sign in with a passkey. Try again, or use your email below.';

	async function signInWithPasskey() {
		if (signingIn) return;
		signingIn = true;
		passkeyError = null;

		try {
			const result = await authClient.signIn.passkey().catch(() => null);
			if (!result || result.error) {
				// A failure or a cancelled prompt — never resume on whatever session
				// may already exist.
				passkeyError = PASSKEY_ERROR;
				return;
			}
			// Full-page reload so the server decides, with the new session.
			window.location.assign(continueTo);
		} finally {
			signingIn = false;
		}
	}
</script>

<svelte:head>
	<title>Connect an app · Pay with me</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title role="heading" aria-level={1} class="text-2xl">Connect to Pay with me</Card.Title>
		<Card.Description>
			Sign in to let the app you're connecting reach your Pay with me account. You'll choose what it
			can do — read-only, or full access — on the next screen.
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-6">
		<!-- Primary: passkey (PLAN §5.5). On success we resume the OAuth authorization. -->
		<div class="space-y-3">
			{#if passkeyError}
				<p class="text-sm text-destructive" role="alert">{passkeyError}</p>
			{/if}
			<Button type="button" class="w-full" disabled={signingIn} onclick={signInWithPasskey}>
				{signingIn ? 'Signing in…' : 'Sign in with a passkey'}
			</Button>
		</div>

		<!-- Divider. -->
		<div class="flex items-center gap-3" aria-hidden="true">
			<span class="h-px flex-1 bg-border"></span>
			<span class="text-xs text-muted-foreground uppercase">or</span>
			<span class="h-px flex-1 bg-border"></span>
		</div>

		<!-- Fallback: email magic link. `continueTo` rides the hidden `redirectTo` so
		     the `/auth/magic-link` landing comes back here after verification, and
		     `load` resumes (also covering the cross-device case). -->
		<MagicLinkForm data={data.form} redirectTo={continueTo} />
	</Card.Content>
</Card.Root>
