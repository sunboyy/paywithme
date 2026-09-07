<script lang="ts">
	// `/settings/api-keys` — the key list (PLAN §16.8).
	//
	// Every row shows every field (no collapsing on mobile — §16.8) and revokes
	// through a real form action, confirmed by `ConfirmSubmit`. Creating a key is
	// its own screen, so this one has a single primary CTA.
	import { resolve } from '$app/paths';
	import { superForm } from 'sveltekit-superforms';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import FormStatus from '$lib/components/FormStatus.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import SettingsNav from '$lib/components/SettingsNav.svelte';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The per-row revoke forms share ONE superForm so the action `message` is
	// captured once; each row's hidden `id` names its own key.
	// svelte-ignore state_referenced_locally
	const revokeForm = superForm(data.revokeApiKeyForm);
	const { message: revokeMessage, enhance: revokeEnhance, submitting: revoking } = revokeForm;

	const newKeyHref = resolve('/settings/api-keys/new');

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
	<title>API keys · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-6">
	<PageHeader
		title="API keys"
		description="API keys let a script or an AI agent act on your behalf through the Pay with me API. A key sees exactly the groups you see."
	>
		{#snippet actions()}
			<!-- Discoverability (PLAN §16.9): the prose docs + raw spec are one tap
			     away from where you mint the key they describe. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<Button variant="ghost" size="sm" href="/docs/api">
				<BookOpenIcon class="size-4" aria-hidden="true" />
				API docs
			</Button>
		{/snippet}
	</PageHeader>

	<SettingsNav current="api-keys" />

	<FormStatus message={$revokeMessage} />

	<Card.Root>
		<Card.Header>
			<Card.Title>Your keys</Card.Title>
			<Card.Description>
				A key is shown once, when you create it. Revoke one the moment you no longer need it.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			{#if data.apiKeys.length === 0}
				<!-- First-run: two EQUAL-WEIGHT buttons — Create key + View API docs
				     (PLAN §16.8), both real links (no client-only fetches). -->
				<EmptyState
					inline
					testId="api-keys-empty"
					title="No API keys yet"
					description="Create a key to let an agent or script read your groups — or, if you trust it, record and settle transactions for you."
					icon={TerminalIcon}
				>
					{#snippet action()}
						<div class="flex flex-col gap-2 sm:flex-row">
							<Button href={newKeyHref}>Create key</Button>
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
							<Button variant="outline" href="/docs/api">View API docs</Button>
						</div>
					{/snippet}
				</EmptyState>
			{:else}
				<!-- Mobile: every field stays visible (PLAN §16.8 "no collapsing") — the
				     row simply stacks instead of hiding anything. -->
				<ul class="divide-y divide-border" aria-label="Your API keys">
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
									<p class="font-mono text-xs break-all text-muted-foreground">
										{apiKey.start}…
									</p>
								{/if}
								<p class="text-xs text-muted-foreground">
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

				<Button variant="outline" class="w-full" href={newKeyHref}>
					<PlusIcon class="size-4" aria-hidden="true" />
					Create another key
				</Button>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
