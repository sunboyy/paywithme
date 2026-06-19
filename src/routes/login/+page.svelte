<script lang="ts">
	// `/login` (PLAN §5.1, §5.5). Passkey is the PRIMARY path; the email
	// magic-link form is the always-available fallback (new device / lost passkey).
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/auth-client';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import MagicLinkForm from './magic-link-form.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Optional sanitized post-auth destination (task 3.7). The server already
	// sanitized it; we only use it to override the default `goto`/links target.
	const redirectTo = $derived(data.redirectTo ?? null);
	const registerHref = $derived(
		redirectTo ? '/register?redirectTo=' + encodeURIComponent(redirectTo) : resolve('/register')
	);

	// Passkey sign-in state. The button is a real <button type="button"> so it
	// never submits the email form; WebAuthn is inherently JS-only, so this path
	// simply does nothing without JS (the email fallback covers no-JS).
	let signingIn = $state(false);
	let passkeyError = $state<string | null>(null);

	// Conditional UI / autofill (`signIn.passkey({ autoFill: true })`) is OPTIONAL
	// per the task and is intentionally SKIPPED here: the explicit button is the
	// requirement, and wiring autofill cleanly (mount lifecycle + a
	// `autocomplete="... webauthn"` field) would complicate the page and tests for
	// little gain. It can be layered on later without changing this contract.

	async function signInWithPasskey() {
		if (signingIn) return;
		signingIn = true;
		passkeyError = null;

		try {
			// better-auth client returns `{ data, error }` — it does not throw for
			// auth failures. On `error`, show a friendly message (never the raw
			// object). A user cancelling the OS WebAuthn prompt surfaces as an error
			// too; treat that as a non-event so we don't show scary copy.
			const { data: result, error } = await authClient.signIn.passkey();

			if (error) {
				passkeyError = 'Could not sign in with a passkey. Try again, or use your email below.';
				return;
			}

			if (result) {
				// `signIn.passkey()` set the better-auth session cookie client-side, but
				// the root `+layout.server.ts` load already ran while logged-out (→
				// `user: null`). A plain `goto` would reuse that cached data and leave
				// the header stale ("Sign in" instead of name + "Log out") until a manual
				// refresh. `invalidateAll: true` forces every `load` to re-run so the
				// layout re-reads the now-authenticated session and the chrome reflects it.
				// `redirectTo` is a server-sanitized local path (`safeRedirectTo`), so it's
				// safe to navigate to even though it can't be a statically `resolve()`d
				// route id (it's dynamic — e.g. `/invite/<token>`).
				// eslint-disable-next-line svelte/no-navigation-without-resolve
				await goto(redirectTo ?? resolve('/'), { invalidateAll: true });
			}
		} catch {
			// Defensive: an unexpected thrown error (e.g. WebAuthn cancellation in
			// some browsers) should not crash the UI or leak details.
			passkeyError = 'Could not sign in with a passkey. Try again, or use your email below.';
		} finally {
			signingIn = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in · Pay with me</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title role="heading" aria-level={1} class="text-2xl">Sign in</Card.Title>
		<Card.Description>
			Use your passkey for the fastest sign-in, or get a single-use link by email.
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-6">
		<!-- Primary: passkey (PLAN §5.5). -->
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

		<!-- Fallback: email magic link (PLAN §5.5 / §5.3). -->
		<MagicLinkForm data={data.form} {redirectTo} />
	</Card.Content>

	<Card.Footer>
		<p class="text-muted-foreground text-sm">
			Don't have an account?
			<!-- `registerHref` is a server-sanitized local path; dynamic, so not `resolve()`able. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a href={registerHref} class="text-foreground font-medium underline underline-offset-4"
				>Create one</a
			>
		</p>
	</Card.Footer>
</Card.Root>
