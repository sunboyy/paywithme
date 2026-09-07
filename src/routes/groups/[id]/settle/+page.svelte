<script lang="ts">
	// `/groups/[id]/settle` — debt summary + settlement suggestions (task 5.4;
	// PLAN §8, §8.2, §8.4, §10).
	//
	// Mobile-first, server-first read-only page. Two sections:
	//   1. "Who should pay" (§8.2): every member ordered most-negative-first with a
	//      signed settlement-currency amount — surfaced prominently at the top.
	//   2. Suggested settlements (§8.3): each "{debtor} pays {creditor} {amount}"
	//      row has a "Settle up" link that PREFILLS a Transfer at
	//      `/groups/[id]/transactions/new` (payer = debtor, recipient = creditor,
	//      category = Debt settlement). On save it's a normal transaction (§8.4).
	//
	// Each suggestion row also EXPANDS to the creditor's receiving details (issue
	// #86; PLAN §8.4, §17.3–§17.4) — the account the debtor is about to transfer to.
	// A native `<details>` per row, closed by default: §17.3 says shown on demand,
	// never printed inline, and a native disclosure keeps that true with JS off.
	//
	// When the creditor is the VIEWER and their own profile is empty, that same
	// disclosure offers the link to `/settings/receiving` (issue #87; PLAN §17.4
	// case 3) and starts OPEN. Closed-by-default is right for the other states —
	// they exist for the debtor, who taps the row when they are ready to pay — but
	// nobody taps "How to pay <their own name>" to read about themselves, and a
	// prompt behind that tap is a prompt nobody sees. §17.4 wants it at the moment
	// the screen says people owe them money, which is this row, on arrival.
	//
	// shadcn-svelte components are used from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored / edited here). Mirrors the transactions / members pages.
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import GroupNav from '$lib/components/GroupNav.svelte';
	import ReceivingMethodsPanel from '$lib/components/ReceivingMethodsPanel.svelte';
	import { network } from '$lib/pwa/online.svelte';
	import { OFFLINE_WRITE_MESSAGE } from '$lib/pwa/offline-writes';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const newPath = $derived(resolve('/groups/[id]/transactions/new', { id: data.group.id }));
	const membersPath = $derived(resolve('/groups/[id]/members', { id: data.group.id }));
	const receivingSettingsPath = resolve('/settings/receiving');

	/**
	 * Build the §8.4 "Settle up" prefill link for a suggestion: the add-transaction
	 * page seeded as a Transfer (payer = debtor, recipient = creditor, the settlement
	 * amount, category = Debt settlement). The amount is already in MINOR UNITS (no
	 * float parsing). Mirrors `transactions/+page.svelte`'s `filterUrl`: a `resolve()`d
	 * path with a manually-appended query string (the eslint-disable is at the
	 * navigation call site, the <a href>, below).
	 */
	function settleUrl(s: { fromMemberId: string; toMemberId: string; amount: number }): string {
		const params = [
			'type=transfer',
			`from=${encodeURIComponent(s.fromMemberId)}`,
			`to=${encodeURIComponent(s.toMemberId)}`,
			`amount=${s.amount}`,
			'category=transfer-debt-settlement'
		];
		return `${newPath}?${params.join('&')}`;
	}
</script>

<svelte:head>
	<title>Settle up · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl space-y-4">
	<!-- Same header shape as Overview and Transactions — this page was the only
	     group screen missing the "+ Add" action, for no reason a user could infer. -->
	<header class="space-y-3">
		<div class="flex items-center justify-between gap-3">
			<h1 class="truncate text-2xl font-semibold tracking-tight">{data.group.name}</h1>
			<Button href={newPath} class="shrink-0 gap-1">
				<PlusIcon class="size-4" aria-hidden="true" />
				Add
			</Button>
		</div>
		<GroupNav groupId={data.group.id} current="settle" />
	</header>

	<!-- §8.2 "Who should pay": balances ordered most-negative-first, surfaced
	     prominently. Signed settlement-currency amounts; debtors highlighted. -->
	<Card.Root>
		<Card.Header>
			<Card.Title>Balances</Card.Title>
			<Card.Description>
				Who owes and who is owed, in {data.group.settlementCurrency}. The biggest debt is at the
				top.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<ul class="divide-y divide-border" aria-label="Member balances">
				{#each data.balances as row (row.memberId)}
					<li class="flex items-center justify-between gap-2 py-3">
						<span class="flex items-center gap-2">
							<span class="font-medium">{row.displayName}</span>
							{#if row.isDebtor}
								<Badge variant="secondary">owes</Badge>
							{:else if row.isCreditor}
								<Badge variant="secondary">is owed</Badge>
							{:else}
								<Badge variant="outline">settled</Badge>
							{/if}
							{#if !row.isActive}
								<Badge variant="outline" class="text-muted-foreground">Inactive</Badge>
							{/if}
						</span>
						<!-- Semantic money colours (see the group overview): --destructive is
						     reserved for destructive ACTIONS, not for owing money. -->
						<span
							class="shrink-0 font-medium tabular-nums {row.isDebtor
								? 'text-money-negative'
								: row.isCreditor
									? 'text-money-positive'
									: 'text-muted-foreground'}"
						>
							{row.balanceFormatted}
						</span>
					</li>
				{/each}
			</ul>
		</Card.Content>
	</Card.Root>

	<!-- §8.3/§8.4 Suggested settlements: minimal set of transfers. Each row prefills
	     a Transfer at the add page. Empty state = all settled up. -->
	{#if data.allSettled}
		<!-- Deliberate cleared state (task 8.1): everyone's square. Uses the shared
		     EmptyState so it reads consistently with the other screens; no CTA — the
		     happy path here is "nothing to do". -->
		<EmptyState
			icon={CheckCircle2Icon}
			title="All settled up"
			description="Everyone's square — there's nothing to settle right now."
		/>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title>Suggested settlements</Card.Title>
				<Card.Description>
					The fewest transfers to square everyone up. Tap "Settle up" to record one as a transfer.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<ul class="space-y-2" aria-label="Suggested settlements">
					{#each data.suggestions as s (s.fromMemberId + '→' + s.toMemberId)}
						{@const receiving = data.receiving[s.toMemberId]}
						<!-- The action sits INLINE on the right at every width. It used to stack
						     below the row on phones as a full-width primary button, so three
						     suggestions filled the viewport with three equally-loud black CTAs
						     and each row cost three lines instead of one. `outline` because
						     these are peers, not the page's single primary action; the 44px
						     touch target is unchanged. -->
						<li class="rounded-lg border bg-card">
							<div class="flex items-center justify-between gap-3 p-3">
								<span class="flex min-w-0 flex-1 items-center gap-2">
									<HandshakeIcon class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
									<span class="min-w-0">
										<span class="flex flex-wrap items-center gap-1.5 font-medium">
											<span class="truncate">{s.fromDisplayName}</span>
											<ArrowRightIcon
												class="size-4 shrink-0 text-muted-foreground"
												aria-hidden="true"
											/>
											<span class="sr-only">pays</span>
											<span class="truncate">{s.toDisplayName}</span>
										</span>
										<span class="block text-sm text-muted-foreground tabular-nums">
											{s.amountFormatted}
										</span>
									</span>
								</span>
								<!-- §8.4: prefill a Transfer (payer=debtor, recipient=creditor, amount,
							     category=Debt settlement). The href is a `resolve()`d path with an
							     appended query string (already a resolved URL). -->
								<!-- Offline (PLAN §11 — no offline creation): "Settle up" starts a write
							     flow, so it's disabled offline as a real <button> with an accessible
							     reason; online it's the prefill navigation link. -->
								{#if network.offline}
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="min-h-11 shrink-0"
										disabled
										title={OFFLINE_WRITE_MESSAGE}
									>
										Settle up
									</Button>
								{:else}
									{@const settleHref = settleUrl(s)}
									<!-- `settleHref` is a `resolve()`d path with an appended query string, so
								     it is already a resolved URL. Disable/enable PAIR, not `-next-line`:
								     the <a> now spans several lines and the single-line form only covers
								     the tag's first line, leaving the href itself flagged. -->
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href={settleHref}
										class={buttonVariants({ variant: 'outline', size: 'sm' }) +
											' min-h-11 shrink-0'}
									>
										Settle up
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								{/if}
							</div>

							<!-- §8.4 / §17.3: the account details the debtor needs in order to
							     actually send the money. ON DEMAND — a native <details>, closed by
							     default, never printed in the row itself. It opens without JS.
							     The one row that starts open is the viewer's own empty profile
							     (§17.4 case 3): that panel is addressed to them, not to a payer. -->
							{#if receiving}
								<!-- `open` is a one-way default, not a bound state: the viewer can still
								     close it, and it is the browser's own <details> either way. -->
								<details
									class="group border-t"
									data-testid="how-to-pay"
									open={receiving.state === 'own-empty'}
								>
									<summary
										class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
									>
										How to pay {s.toDisplayName}
										<ChevronDownIcon
											class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
											aria-hidden="true"
										/>
									</summary>
									<div class="px-3 pt-1 pb-3">
										<ReceivingMethodsPanel
											view={receiving}
											displayName={s.toDisplayName}
											inviteUrl={data.inviteUrl}
											invitesHref={membersPath}
											receivingSettingsHref={receivingSettingsPath}
										/>
									</div>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
