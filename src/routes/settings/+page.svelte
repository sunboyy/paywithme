<script lang="ts">
	// `/settings` — manage passkeys across devices (PLAN §5.4–§5.6).
	//
	// Add: client-side WebAuthn (`authClient.passkey.addPasskey()`), same pattern
	// as task 2.8's onboarding nudge — JS-only by nature, with friendly cancel /
	// error handling and `invalidateAll()` to surface the new passkey.
	// Delete: a real server-action `<form>` per row (works without JS); the action
	// status surfaces via `role="status"` / `role="alert"`.
	import { invalidateAll } from '$app/navigation';
	import { superForm } from 'sveltekit-superforms';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { authClient } from '$lib/auth-client';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
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

	const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	function formatCreated(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '' : dateFormatter.format(d);
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
</div>
