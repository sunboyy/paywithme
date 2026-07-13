<script lang="ts">
	// `/settings` — manage passkeys across devices (PLAN §5.4–§5.6).
	//
	// Add: client-side WebAuthn (`authClient.passkey.addPasskey()`), same pattern
	// as task 2.8's onboarding nudge — JS-only by nature, with friendly cancel /
	// error handling and `invalidateAll()` to surface the new passkey.
	// Delete: a real server-action `<form>` per row (works without JS); the action
	// status surfaces via `role="status"` / `role="alert"`.
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { authClient } from '$lib/auth-client';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The per-row delete forms share one superForm so the action `message`
	// (success/error) is captured once. `data.deleteForm` is the seeded form.
	// svelte-ignore state_referenced_locally
	const deleteForm = superForm(data.deleteForm);
	const { message: deleteMessage, enhance: deleteEnhance, submitting: deleting } = deleteForm;

	// Client-side enrolment state (WebAuthn is JS-only — there is deliberately no
	// no-JS path for *adding*; deleting works without JS, which is what matters).
	let enrolling = $state(false);
	let enrolError = $state<string | null>(null);

	async function addPasskey() {
		if (enrolling) return;
		enrolling = true;
		enrolError = null;

		try {
			// better-auth client returns `{ data, error }` and does not throw for the
			// usual failures. A user cancelling the OS prompt surfaces as an error (or,
			// in some browsers, a thrown exception) — treat both as a non-scary
			// non-event (same approach as task 2.8).
			const { error } = await authClient.passkey.addPasskey();

			if (error) {
				enrolError = 'Could not add a passkey. Please try again.';
				return;
			}

			// Re-run `load` so the freshly enrolled passkey appears without a reload.
			await invalidateAll();
		} catch {
			enrolError = 'Could not add a passkey. Please try again.';
		} finally {
			enrolling = false;
		}
	}

	// API-key revoke (PLAN §16.8) — the same one-superForm-for-all-rows shape as
	// the passkey delete above: each row posts a real `<form>` to `?/revokeApiKey`
	// (works with JS disabled), confirmed through `ConfirmSubmit`.
	// svelte-ignore state_referenced_locally
	const revokeForm = superForm(data.revokeApiKeyForm);
	const { message: revokeMessage, enhance: revokeEnhance, submitting: revoking } = revokeForm;

	const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	function formatCreated(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '' : dateFormatter.format(d);
	}

	/** "Never used" until the plugin's `lastRequest` is stamped by a real call. */
	function formatLastUsed(iso: string | null): string {
		return iso ? `Last used ${formatCreated(iso)}` : 'Never used';
	}

	/** Expiry line — expired keys are called out, not silently listed as normal. */
	function formatExpiry(iso: string | null, expired: boolean): string {
		if (!iso) return 'Never expires';
		return `${expired ? 'Expired' : 'Expires'} ${formatCreated(iso)}`;
	}
</script>

<svelte:head>
	<title>Settings · Pay with me</title>
</svelte:head>

<div class="space-y-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
		<p class="text-muted-foreground text-sm">Manage how you sign in to Pay with me.</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Passkeys</Card.Title>
			<Card.Description>
				Passkeys let you sign in faster with Face ID, a fingerprint, or your screen lock — no email
				link to wait for. Add one for each device you use; you can have as many as you like.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			<!-- Action status (delete success/error), shared across the row forms. -->
			{#if $deleteMessage}
				<p
					class={$deleteMessage.type === 'error' ? 'text-destructive text-sm' : 'text-sm'}
					role={$deleteMessage.type === 'error' ? 'alert' : 'status'}
				>
					{$deleteMessage.text}
				</p>
			{/if}

			<!-- Client enrolment error. -->
			{#if enrolError}
				<p class="text-destructive text-sm" role="alert">{enrolError}</p>
			{/if}

			{#if data.passkeys.length === 0}
				<!-- Nothing-yet empty state (task 8.1). This block lives INSIDE the
				     Passkeys card (the "Add a passkey" button is the primary CTA just
				     below the Separator), so it's an inline centred nudge rather than a
				     nested EmptyState card — same look, real text, decorative icon. -->
				<div
					class="text-muted-foreground flex flex-col items-center gap-3 py-6 text-center"
					data-testid="passkeys-empty"
				>
					<span
						class="bg-muted flex size-12 items-center justify-center rounded-full"
						aria-hidden="true"
					>
						<KeyRoundIcon class="size-6" />
					</span>
					<div class="space-y-1">
						<p class="text-foreground text-base font-medium">No passkeys yet</p>
						<p class="mx-auto max-w-prose text-sm text-pretty">
							Add a passkey to sign in faster next time — with Face ID, a fingerprint, or your
							screen lock instead of an email link.
						</p>
					</div>
				</div>
			{:else}
				<ul class="divide-border divide-y" aria-label="Your passkeys">
					{#each data.passkeys as passkey (passkey.id)}
						<li class="flex items-center justify-between gap-3 py-3">
							<div class="min-w-0 space-y-0.5">
								<p class="truncate font-medium">
									{passkey.name ?? passkey.deviceHint ?? 'Passkey'}
								</p>
								<p class="text-muted-foreground text-xs">
									{#if passkey.name && passkey.deviceHint}{passkey.deviceHint} ·
									{/if}Added {formatCreated(passkey.createdAt)}
								</p>
							</div>

							<ConfirmSubmit
								action="?/delete"
								enhance={deleteEnhance}
								hiddenName="id"
								hiddenValue={passkey.id}
								triggerLabel="Remove"
								title="Remove this passkey?"
								description="You can add it back any time, or sign in using your email."
								confirmLabel="Remove passkey"
								disabled={$deleting}
							/>
						</li>
					{/each}
				</ul>
			{/if}

			<Separator />

			<Button type="button" class="w-full" disabled={enrolling} onclick={addPasskey}>
				{enrolling ? 'Adding passkey…' : 'Add a passkey'}
			</Button>
		</Card.Content>
	</Card.Root>

	<!-- API keys (PLAN §16.8) — the sibling section to passkeys. -->
	<Card.Root>
		<Card.Header>
			<Card.Title>API keys</Card.Title>
			<Card.Description>
				API keys let a script or an AI agent act on your behalf through the Pay with me API. A key
				sees exactly the groups you see.
			</Card.Description>
			<Card.Action>
				<!-- Discoverability (PLAN §16.9): the prose docs + raw spec are one tap away
				     from where you mint the key they describe. -->
				<Button variant="ghost" size="sm" href={resolve('/docs/api')}>API docs</Button>
			</Card.Action>
		</Card.Header>

		<Card.Content class="space-y-4">
			<!-- Revoke success/error, shared across the per-row forms. -->
			{#if $revokeMessage}
				<p
					class={$revokeMessage.type === 'error' ? 'text-destructive text-sm' : 'text-sm'}
					role={$revokeMessage.type === 'error' ? 'alert' : 'status'}
				>
					{$revokeMessage.text}
				</p>
			{/if}

			{#if data.apiKeys.length === 0}
				<!-- First-run: two EQUAL-WEIGHT buttons — Create key + View API docs
				     (PLAN §16.8), both real links (no client-only fetches). -->
				<EmptyState
					title="No API keys yet"
					description="Create a key to let an agent or script read your groups — or, if you trust it, record and settle transactions for you."
					icon={TerminalIcon}
				>
					{#snippet action()}
						<div class="flex flex-col gap-2 sm:flex-row">
							<Button href={resolve('/settings/api-keys/new')}>Create key</Button>
							<Button variant="outline" href={resolve('/docs/api')}>View API docs</Button>
						</div>
					{/snippet}
				</EmptyState>
			{:else}
				<!-- Mobile: every field stays visible (PLAN §16.8 "no collapsing") — the
				     row simply stacks instead of hiding anything. -->
				<ul class="divide-border divide-y" aria-label="Your API keys">
					{#each data.apiKeys as apiKey (apiKey.id)}
						<li
							class="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
							data-testid="api-key-row"
						>
							<div class="min-w-0 space-y-1">
								<div class="flex flex-wrap items-center gap-2">
									<p class="truncate font-medium">{apiKey.name ?? 'API key'}</p>
									<Badge variant={apiKey.scope === 'write' ? 'default' : 'secondary'}>
										{apiKey.scope === 'write' ? 'Read & write' : 'Read only'}
									</Badge>
									{#if apiKey.expired}
										<Badge variant="destructive">Expired</Badge>
									{/if}
								</div>
								{#if apiKey.start}
									<!-- The `start` prefix is safe to show (PLAN §16.1) — it's how you
									     tell two keys apart without ever revealing a secret. -->
									<p class="text-muted-foreground font-mono text-xs break-all">
										{apiKey.start}…
									</p>
								{/if}
								<p class="text-muted-foreground text-xs">
									Created {formatCreated(apiKey.createdAt)} · {formatLastUsed(apiKey.lastRequest)} ·
									{formatExpiry(apiKey.expiresAt, apiKey.expired)}
								</p>
							</div>

							<ConfirmSubmit
								action="?/revokeApiKey"
								enhance={revokeEnhance}
								hiddenName="id"
								hiddenValue={apiKey.id}
								triggerLabel="Revoke"
								title="Revoke this API key?"
								description="Anything using this key stops working immediately. This can't be undone — you'd need to create a new key."
								confirmLabel="Revoke key"
								disabled={$revoking}
							/>
						</li>
					{/each}
				</ul>

				<Separator />

				<Button variant="outline" class="w-full" href={resolve('/settings/api-keys/new')}>
					Create another key
				</Button>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
