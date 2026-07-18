<script lang="ts">
	// `/oauth/login` — the dedicated sign-in for the Claude.ai (MCP OAuth connector)
	// authorization flow. Reached only from better-auth's authorize endpoint
	// (`mcp({ loginPage: '/oauth/login' })`); the load redirects here-without-an-
	// OAuth-request back to the normal `/login`, so `oauthResume` is ALWAYS set.
	//
	// After sign-in we complete the authorization with a FULL-PAGE navigation to the
	// authorize endpoint (a client `goto`/fetch can't cross to the OAuth client's
	// origin). Passkey (WebAuthn) is a client fetch, and the plugin's post-login
	// hook can rewrite that response into a swallowed cross-origin redirect, so we
	// decide by the REAL session (`getSession`), not the fetch outcome.
	import { authClient } from '$lib/auth-client';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	// Shared with `/login` (kept in that route so `/login` stays untouched).
	import MagicLinkForm from '../../login/magic-link-form.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The same-origin `/api/auth/mcp/authorize?…` URL that resumes the connector
	// flow. Always present on this page.
	const oauthResume = $derived(data.oauthResume);

	let signingIn = $state(false);
	let passkeyError = $state<string | null>(null);
	const PASSKEY_ERROR = 'Could not sign in with a passkey. Try again, or use your email below.';

	async function signInWithPasskey() {
		if (signingIn) return;
		signingIn = true;
		passkeyError = null;

		try {
			// The passkey response may have been rewritten into a swallowed cross-origin
			// resume redirect (surfacing as an error/throw) even though the session WAS
			// created — so swallow any outcome here and decide by the session below.
			await authClient.signIn.passkey().catch(() => undefined);
			await resumeIfSignedIn();
		} finally {
			signingIn = false;
		}
	}

	async function resumeIfSignedIn() {
		const { data: session } = await authClient.getSession();
		if (session?.user) {
			// Full-page navigation so the authorize endpoint's 302 to the OAuth client's
			// callback is followed by the browser. `oauthResume` is a server-built local
			// path, so this is not an open redirect.
			window.location.assign(oauthResume);
			return;
		}
		// No session → a genuine passkey failure (or the user cancelled).
		passkeyError = PASSKEY_ERROR;
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
				<p class="text-destructive text-sm" role="alert">{passkeyError}</p>
			{/if}
			<Button type="button" class="w-full" disabled={signingIn} onclick={signInWithPasskey}>
				{signingIn ? 'Signing in…' : 'Sign in with a passkey'}
			</Button>
		</div>

		<!-- Divider. -->
		<div class="flex items-center gap-3" aria-hidden="true">
			<span class="bg-border h-px flex-1"></span>
			<span class="text-muted-foreground text-xs uppercase">or</span>
			<span class="bg-border h-px flex-1"></span>
		</div>

		<!-- Fallback: email magic link. `oauthResume` rides the hidden `redirectTo` so
		     the `/auth/magic-link` landing forwards to the authorize endpoint after
		     verification (also covering the cross-device case). -->
		<MagicLinkForm data={data.form} redirectTo={oauthResume} />
	</Card.Content>
</Card.Root>
