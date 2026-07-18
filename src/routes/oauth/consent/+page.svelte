<script lang="ts">
	// `/oauth/consent` — the MCP OAuth connector consent screen (ADR-0010
	// §Decision(4), #41).
	//
	// SERVER-FIRST + PROGRESSIVE. The Allow / Deny decision is a plain <form> POST to
	// the route's `allow` / `deny` actions, so it works with JS disabled. `use:enhance`
	// only upgrades it: the actions redirect to an EXTERNAL client `redirect_uri`, so
	// the enhance callback forwards a redirect result via `window.location` (SvelteKit's
	// default `goto`-based redirect handling refuses cross-origin destinations).
	//
	// The read-vs-write ("can this connection move money?") distinction is the single
	// most consequential fact here, so it is spelled out with the SAME copy as the
	// api-key scope picker (`/settings/api-keys/new`) — the two credential surfaces are
	// one product.
	import { enhance, applyAction } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Follow an EXTERNAL redirect (the client's `redirect_uri`) ourselves — the
	// default enhance handler only navigates to same-origin destinations.
	const followExternalRedirect: SubmitFunction = () => {
		return async ({ result }) => {
			if (result.type === 'redirect') {
				window.location.href = result.location;
				return;
			}
			await applyAction(result);
		};
	};

	// The two scope-safety statements, reused verbatim from the api-key picker so the
	// money-moving vs read-only choice reads identically across both surfaces (§16.2).
	const READ_SAFETY = 'Cannot create, edit, or delete anything — it can never move money.';
	const WRITE_SAFETY = 'Can move money on your behalf. Only give this to tools you trust.';
</script>

<svelte:head>
	<title>Authorize a connection · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-xl space-y-6 py-8">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold tracking-tight">Authorize a connection</h1>
		<p class="text-muted-foreground text-sm">
			An app wants to connect to your Pay with me account and act on your behalf — it will see
			exactly the groups you see.
		</p>
	</div>

	{#if !data.consentCode}
		<!-- Reached without an active consent request (e.g. a stale/expired link). -->
		<Card.Root>
			<Card.Header>
				<Card.Title>This request has expired</Card.Title>
				<Card.Description>
					We couldn't find an active authorization request. Return to the app and start the
					connection again.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{:else}
		{#if form?.error}
			<p class="text-destructive text-sm" role="alert">{form.error}</p>
		{/if}

		<Card.Root>
			<Card.Header>
				<Card.Title>Requesting app</Card.Title>
				<Card.Description>
					{#if data.clientId}
						<span class="font-mono break-all">{data.clientId}</span>
					{:else}
						An unnamed client
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<p class="text-sm font-medium">This connection would be able to:</p>

				<!-- The money-safety distinction, front and centre (§16.2 / ADR-0007). -->
				<div
					class="flex gap-3 rounded-lg border p-4 {data.canMoveMoney
						? 'border-destructive/40 bg-destructive/5'
						: 'border-input'}"
				>
					{#if data.canMoveMoney}
						<PencilIcon class="text-destructive mt-0.5 size-5 shrink-0" aria-hidden="true" />
						<div class="min-w-0 space-y-1">
							<p class="font-medium">Read &amp; write access</p>
							<p class="text-muted-foreground text-sm">
								View your groups, transactions, members, and balances — plus record and settle
								transactions.
							</p>
							<p class="text-destructive text-sm font-medium">{WRITE_SAFETY}</p>
						</div>
					{:else}
						<EyeIcon class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
						<div class="min-w-0 space-y-1">
							<p class="font-medium">Read-only access</p>
							<p class="text-muted-foreground text-sm">
								View your groups, transactions, members, and balances.
							</p>
							<p class="text-foreground text-sm font-medium">{READ_SAFETY}</p>
						</div>
					{/if}
				</div>

				<details class="text-muted-foreground text-sm">
					<summary class="cursor-pointer">Requested scopes</summary>
					<ul class="mt-2 flex flex-wrap gap-1.5">
						{#each data.scopes as scope (scope)}
							<li class="bg-muted rounded px-2 py-0.5 font-mono text-xs">{scope}</li>
						{/each}
					</ul>
				</details>
			</Card.Content>
		</Card.Root>

		<!-- One form, two actions. Native submit buttons + `formaction` keep the whole
		     Allow/Deny decision working with JS disabled; `use:enhance` upgrades it. -->
		<form
			method="POST"
			use:enhance={followExternalRedirect}
			class="flex flex-col gap-3 sm:flex-row-reverse"
		>
			<input type="hidden" name="consent_code" value={data.consentCode} />
			<Button type="submit" formaction="?/allow" class="w-full sm:w-auto">
				Allow{data.canMoveMoney ? ' — this can move money' : ''}
			</Button>
			<Button type="submit" formaction="?/deny" variant="outline" class="w-full sm:w-auto">
				Deny
			</Button>
		</form>
	{/if}
</div>
