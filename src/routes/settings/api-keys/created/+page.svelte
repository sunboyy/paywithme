<script lang="ts">
	// One-time secret reveal (PLAN §16.8): an inline MASKED banner with a show
	// toggle, a copy button, and the "you won't see this again" warning.
	//
	// NO-JS FRIENDLY BY CONSTRUCTION:
	//   - the masked value is rendered server-side and is the default state;
	//   - "Show key" is a native `<details>`/`<summary>` disclosure — it toggles
	//     with zero JavaScript, and the full secret is selectable text inside it,
	//     so a no-JS user can still select-and-copy it manually;
	//   - the Copy button is the ONLY enhancement, and it is rendered only after
	//     mount (the Clipboard API is inherently JS) — so no-JS users never see a
	//     dead control.
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let mounted = $state(false);
	let copied = $state(false);
	let copyFailed = $state(false);
	onMount(() => {
		mounted = true;
	});

	async function copyKey() {
		copyFailed = false;
		try {
			await navigator.clipboard.writeText(data.key);
			copied = true;
			// Revert the affordance so it can be used again (and so the "Copied"
			// state never reads as permanent).
			setTimeout(() => (copied = false), 2000);
		} catch {
			// Clipboard can be blocked by permissions/insecure context — say so
			// rather than silently doing nothing; the key is visible and selectable.
			copyFailed = true;
		}
	}

	const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
	const expiryLabel = $derived(
		data.expiresAt ? `Expires ${dateFormatter.format(new Date(data.expiresAt))}` : 'Never expires'
	);
</script>

<svelte:head>
	<title>Your new API key · Pay with me</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold tracking-tight">Your new API key</h1>
		<p class="text-muted-foreground text-sm">
			{data.name ?? 'API key'} was created.
		</p>
	</div>

	<Card.Root data-testid="api-key-reveal">
		<Card.Header>
			<Card.Title class="flex items-center gap-2">
				<TriangleAlertIcon class="text-destructive size-5 shrink-0" aria-hidden="true" />
				Copy your key now
			</Card.Title>
			<Card.Description>
				<!-- The load-bearing warning (PLAN §16.8). Stated plainly, once. -->
				This is the only time the key is shown — <strong>you won't see it again.</strong> We store only
				a hashed copy, so it can't be recovered. If you lose it, revoke the key and create a new one.
			</Card.Description>
		</Card.Header>

		<Card.Content class="space-y-4">
			<div class="flex flex-wrap items-center gap-2">
				<Badge variant={data.scope === 'write' ? 'default' : 'secondary'}>
					{data.scope === 'write' ? 'Read & write' : 'Read only'}
				</Badge>
				<Badge variant="outline">{expiryLabel}</Badge>
			</div>

			<!-- Masked by default; the full value lives behind a JS-free disclosure. -->
			<div class="bg-muted/50 space-y-3 rounded-lg border p-3">
				<p
					class="text-muted-foreground font-mono text-sm break-all"
					data-testid="api-key-masked"
					aria-hidden="true"
				>
					{data.masked}
				</p>

				<details class="group">
					<summary
						class="text-primary focus-visible:ring-ring w-fit cursor-pointer rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
					>
						<span class="group-open:hidden">Show key</span>
						<span class="hidden group-open:inline">Hide key</span>
					</summary>
					<div class="mt-3 space-y-3">
						<code
							class="bg-background block w-full rounded-md border p-3 font-mono text-sm break-all select-all"
							data-testid="api-key-secret">{data.key}</code
						>
						{#if mounted}
							<Button type="button" variant="outline" size="sm" onclick={copyKey}>
								{#if copied}
									<CheckIcon class="size-4" aria-hidden="true" />
									Copied
								{:else}
									<CopyIcon class="size-4" aria-hidden="true" />
									Copy key
								{/if}
							</Button>
							<span class="sr-only" role="status">{copied ? 'API key copied' : ''}</span>
							{#if copyFailed}
								<p class="text-destructive text-sm" role="alert">
									Couldn't copy automatically — select the key above and copy it manually.
								</p>
							{/if}
						{/if}
					</div>
				</details>
			</div>

			<p class="text-muted-foreground text-sm">
				Send it as <code class="bg-muted rounded px-1 py-0.5 text-xs"
					>Authorization: Bearer &lt;key&gt;</code
				> on requests to the API.
			</p>
		</Card.Content>

		<Card.Footer class="flex flex-col gap-3 sm:flex-row">
			<Button href={resolve('/settings')} class="w-full sm:w-auto">Done</Button>
			<!-- `/docs/api` arrives with PLAN §16.9 (separate ticket) — not yet a known
			     route id, so `resolve()` can't type it. -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<Button variant="outline" href="/docs/api" class="w-full sm:w-auto">View API docs</Button>
		</Card.Footer>
	</Card.Root>
</div>
