<script lang="ts">
	// `/settings` — the ACCOUNT screen: who you are signed in as, and how you sign
	// in (PLAN §5.4–§5.6). Getting paid and API keys are their own screens, reached
	// from the shared settings tabs.
	//
	// Add: client-side WebAuthn (`authClient.passkey.addPasskey()`), same pattern
	// as task 2.8's onboarding nudge — JS-only by nature, with friendly cancel /
	// error handling and `invalidateAll()` to surface the new passkey.
	// Delete: a real server-action `<form>` per row (works without JS); the action
	// status surfaces through the shared `FormStatus` banner.
	import { invalidateAll } from '$app/navigation';
	import { superForm } from 'sveltekit-superforms';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { authClient } from '$lib/auth-client';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SettingsNav from '$lib/components/SettingsNav.svelte';
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

<div class="mx-auto w-full max-w-2xl space-y-6">
	<PageHeader title="Settings" description="Your account, how you get paid, and API access." />

	<SettingsNav current="account" />

	<!-- Who you are. The header only ever showed a truncated name; this says which
	     account the rest of the screen is about. -->
	{#if data.user}
		<Card.Root>
			<Card.Header>
				<Card.Title>Signed in as</Card.Title>
			</Card.Header>
			<Card.Content>
				<div class="min-w-0 space-y-0.5">
					{#if data.user.name}
						<p class="truncate font-medium">{data.user.name}</p>
					{/if}
					<p class="truncate text-sm text-muted-foreground">{data.user.email}</p>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

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
			<FormStatus message={$deleteMessage} />
			<!-- Client enrolment error. -->
			<FormStatus message={enrolError ? { type: 'error', text: enrolError } : null} />

			{#if data.passkeys.length === 0}
				<!-- Nothing-yet nudge. Inline (no nested card) because the "Add a
				     passkey" button just below the Separator is this section's CTA. -->
				<EmptyState
					inline
					testId="passkeys-empty"
					title="No passkeys yet"
					description="Add a passkey to sign in faster next time — with Face ID, a fingerprint, or your screen lock instead of an email link."
					icon={KeyRoundIcon}
				/>
			{:else}
				<ul class="divide-y divide-border" aria-label="Your passkeys">
					{#each data.passkeys as passkey (passkey.id)}
						<li class="flex items-center justify-between gap-3 py-3">
							<div class="min-w-0 space-y-0.5">
								<p class="truncate font-medium">
									{passkey.name ?? passkey.deviceHint ?? 'Passkey'}
								</p>
								<p class="text-xs text-muted-foreground">
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
				<PlusIcon class="size-4" aria-hidden="true" />
				{enrolling ? 'Adding passkey…' : 'Add a passkey'}
			</Button>
		</Card.Content>
	</Card.Root>
</div>
