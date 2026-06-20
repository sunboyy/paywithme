<script lang="ts">
	// `/groups/[id]/transactions/[txid]` — view / edit / soft-delete + restore a
	// single transaction (task 4.11; PLAN §7.1, §7.2, §7.6, §9, §10, §12.1).
	//
	// Mobile-first. Shows a VIEW of the transaction (title, category, type badge,
	// original amount + currency with the settlement equivalent for a foreign txn,
	// the date = `created_at`, payers, per-member resolved settlement shares, and the
	// items/charges breakdown when itemized) and an EDIT affordance that reuses the
	// shared <TransactionForm/> (seeded from the reconstructed input). A SOFT-DELETED
	// txn shows a clear deleted state + a Restore button (editing hidden/blocked). The
	// Delete control is gated by an Alert Dialog naming the txn (destructive confirm +
	// Cancel) that WRAPS a real `?/delete` form, so it still works without JS (the
	// server re-validates + is the source of truth). Restore is non-destructive.
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';
	import { resolve } from '$app/paths';
	import { buildTransactionSchema } from '$lib/schemas/transaction';
	import { applyCharges, type ChargeInput } from '$lib/schemas/transaction';
	import { formatAmount, type CurrencyCode } from '$lib/money';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import CategoryIcon from '$lib/components/CategoryIcon.svelte';
	import TransactionForm from '$lib/components/TransactionForm.svelte';
	import { actionLabel, absoluteTime, relativeTime } from '$lib/activity-labels';
	import { network } from '$lib/pwa/online.svelte';
	import { OFFLINE_WRITE_MESSAGE } from '$lib/pwa/offline-writes';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const detail = $derived(data.detail);
	const settlementCurrency = $derived(data.group.settlementCurrency as CurrencyCode);
	const isDeleted = $derived(detail.deletedAt !== null);

	// Whether the edit form is open (JS-enhanced affordance). A deleted txn can't edit.
	let editing = $state(false);

	const listPath = $derived(resolve('/groups/[id]/transactions', { id: data.group.id }));

	// Client validators mirror the server schema (same factory) so errors surface
	// inline when JS is present; the server re-validates regardless. Built once from
	// the initial page data (it doesn't change after hydration).
	// svelte-ignore state_referenced_locally
	const schema = buildTransactionSchema({
		settlementCurrency: data.group.settlementCurrency as CurrencyCode,
		memberIds: data.members.map((m) => m.id)
	});

	// svelte-ignore state_referenced_locally
	const form = superForm(data.form, {
		dataType: 'json',
		validators: zod4Client(schema)
	});

	function memberName(id: string): string {
		return data.memberNames[id] ?? id;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	// Per-charge signed effect (entry currency) for the breakdown view (§7.2.2). The
	// fold runs over the items subtotal in sort order — exactly the production engine.
	const itemsSubtotal = $derived(detail.items.reduce((acc, i) => acc + i.amount, 0));
	const chargeEffects = $derived(
		applyCharges(itemsSubtotal, detail.charges as ChargeInput[]).perCharge
	);

	function chargeLabel(kind: string): string {
		return kind.charAt(0).toUpperCase() + kind.slice(1);
	}
</script>

<svelte:head>
	<title>{detail.title} · {data.group.name}</title>
</svelte:head>

<div class="mx-auto w-full max-w-lg space-y-4">
	<Button variant="ghost" size="sm" href={listPath} class="gap-1">
		<ArrowLeftIcon class="size-4" aria-hidden="true" />
		Back to transactions
	</Button>

	{#if isDeleted}
		<!-- Soft-deleted state (§9): clear banner + Restore (non-destructive). Editing
		     is hidden/blocked until restored. -->
		<Card.Root class="border-destructive/40">
			<Card.Content class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<p class="text-destructive text-sm font-medium">This transaction was deleted.</p>
					<p class="text-muted-foreground text-xs">
						Deleted {formatDate(detail.deletedAt!)}. Restore it to edit again.
					</p>
				</div>
				<form method="POST" action="?/restore">
					<Button
						type="submit"
						variant="outline"
						class="gap-1"
						disabled={network.offline}
						title={network.offline ? OFFLINE_WRITE_MESSAGE : undefined}
					>
						<RotateCcwIcon class="size-4" aria-hidden="true" />
						Restore
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if editing && !isDeleted}
		<!-- Edit form: reuses <TransactionForm/>, seeded from the reconstructed input. -->
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-2xl">Edit transaction</Card.Title>
				<Card.Description>{data.group.name}</Card.Description>
			</Card.Header>
			<Card.Content>
				<TransactionForm
					{form}
					action="?/edit"
					members={data.members}
					categories={data.categories}
					currency={data.currency}
					currencies={data.currencies}
					submitLabel="Save changes"
				/>
				<div class="mt-2">
					<Button variant="ghost" size="sm" onclick={() => (editing = false)}>Cancel</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<!-- VIEW -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-start gap-3">
					<span
						class="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full"
						aria-hidden="true"
					>
						<CategoryIcon name={detail.categoryIcon} class="size-5" />
					</span>
					<div class="min-w-0 flex-1">
						<Card.Title role="heading" aria-level={1} class="flex items-center gap-2 text-xl">
							<span class="truncate">{detail.title}</span>
							<Badge variant={detail.type === 'transfer' ? 'secondary' : 'outline'}>
								{detail.type}
							</Badge>
						</Card.Title>
						<Card.Description>
							{detail.categoryName} · {formatDate(detail.createdAt)}
						</Card.Description>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="space-y-4">
				<!-- Amount: ORIGINAL entry amount + currency; settlement equivalent for foreign (§7.6). -->
				<div>
					<p class="text-2xl font-semibold tabular-nums">
						{formatAmount(detail.amountTotal, detail.currency)}
					</p>
					{#if detail.isForeign}
						<p class="text-muted-foreground text-sm tabular-nums">
							{formatAmount(detail.amountTotalSettlement, settlementCurrency)} · rate via {detail.currency}
							→ {settlementCurrency}
						</p>
					{/if}
				</div>

				<Separator />

				<!-- Payers (entry currency). -->
				<div class="space-y-1">
					<p class="text-muted-foreground text-xs font-medium uppercase">Paid by</p>
					<ul class="space-y-1">
						{#each detail.payers as payer (payer.memberId)}
							<li class="flex items-center justify-between text-sm">
								<span>{memberName(payer.memberId)}</span>
								<span class="tabular-nums">{formatAmount(payer.amountPaid, detail.currency)}</span>
							</li>
						{/each}
					</ul>
				</div>

				{#if detail.items.length > 0}
					<Separator />
					<!-- Itemized breakdown (§7.2.1): each item + its per-member owed (txn currency). -->
					<div class="space-y-2">
						<p class="text-muted-foreground text-xs font-medium uppercase">Items</p>
						<ul class="space-y-2">
							{#each detail.items as item, i (i)}
								<li class="rounded-md border p-2">
									<div class="flex items-center justify-between text-sm font-medium">
										<span>{item.label}</span>
										<span class="tabular-nums">{formatAmount(item.amount, detail.currency)}</span>
									</div>
									<ul class="text-muted-foreground mt-1 space-y-0.5 text-xs">
										{#each item.shares as share (share.memberId)}
											<li class="flex items-center justify-between">
												<span>{memberName(share.memberId)}</span>
												<span class="tabular-nums"
													>{formatAmount(share.amountOwed, detail.currency)}</span
												>
											</li>
										{/each}
									</ul>
								</li>
							{/each}
						</ul>
					</div>

					{#if detail.charges.length > 0}
						<!-- Charges/discounts breakdown (§7.2.2), each signed effect in sort order. -->
						<div class="space-y-1">
							<p class="text-muted-foreground text-xs font-medium uppercase">Charges</p>
							<ul class="space-y-1 text-sm">
								{#each chargeEffects as effect, i (i)}
									<li class="flex items-center justify-between">
										<span>
											{chargeLabel(effect.charge.kind)}
											{#if effect.charge.mode === 'percent'}
												<span class="text-muted-foreground text-xs">
													({(effect.charge.value / 100).toFixed(2)}%)
												</span>
											{/if}
										</span>
										<span class="tabular-nums">
											{effect.signedEffect < 0 ? '−' : '+'}{formatAmount(
												Math.abs(effect.signedEffect),
												detail.currency
											)}
										</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/if}

				<Separator />

				<!-- Per-member resolved SETTLEMENT shares (the §8 source of truth). -->
				<div class="space-y-1">
					<p class="text-muted-foreground text-xs font-medium uppercase">
						Owed ({settlementCurrency})
					</p>
					<ul class="space-y-1">
						{#each detail.shares as share (share.memberId)}
							<li class="flex items-center justify-between text-sm">
								<span>{memberName(share.memberId)}</span>
								<span class="tabular-nums"
									>{formatAmount(share.amountOwed, settlementCurrency)}</span
								>
							</li>
						{/each}
					</ul>
				</div>
			</Card.Content>

			{#if !isDeleted}
				<Card.Footer class="flex justify-between gap-2">
					<Button
						variant="outline"
						class="gap-1"
						onclick={() => (editing = true)}
						disabled={network.offline}
						title={network.offline ? OFFLINE_WRITE_MESSAGE : undefined}
					>
						<PencilIcon class="size-4" aria-hidden="true" />
						Edit
					</Button>

					<!-- Destructive delete, gated by an Alert Dialog naming the txn (§10). It's a
					     PROGRESSIVE-ENHANCEMENT layer over a real `?/delete` form (the server
					     re-validates + is the source of truth). With JS the trigger (type=button)
					     only OPENS the confirmation, whose Action submits the form; WITHOUT JS the
					     <noscript> button submits the same form directly — so delete always works. -->
					<form method="POST" action="?/delete">
						<AlertDialog.Root>
							<AlertDialog.Trigger
								type="button"
								disabled={network.offline}
								title={network.offline ? OFFLINE_WRITE_MESSAGE : undefined}
								class={buttonVariants({ variant: 'destructive' }) + ' gap-1'}
							>
								<Trash2Icon class="size-4" aria-hidden="true" />
								Delete
							</AlertDialog.Trigger>
							<AlertDialog.Content>
								<AlertDialog.Header>
									<AlertDialog.Title>Delete '{detail.title}'?</AlertDialog.Title>
									<AlertDialog.Description>
										This soft-deletes the transaction. It's hidden from the list but can be restored
										later. This action is recorded in the group's history.
									</AlertDialog.Description>
								</AlertDialog.Header>
								<AlertDialog.Footer>
									<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
									<AlertDialog.Action type="submit" variant="destructive">
										Delete transaction
									</AlertDialog.Action>
								</AlertDialog.Footer>
							</AlertDialog.Content>
						</AlertDialog.Root>
						<!-- No-JS fallback: the dialog needs JS to open, so without it this real
						     submit button posts the same `?/delete` action (server-side guard stands). -->
						<noscript>
							<button type="submit" class={buttonVariants({ variant: 'destructive' }) + ' gap-1'}>
								Delete transaction
							</button>
						</noscript>
					</form>
				</Card.Footer>
			{/if}
		</Card.Root>
	{/if}

	<!-- History: this transaction's OWN audit trail (§12.1) — entries filtered to its
	     entity_id, newest-first. Read-only; no mutation/audit write here. Times render
	     in the viewer's locale/timezone. Shared action labels + time helpers
	     ($lib/activity-labels) keep this identical to the group activity feed. -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">History</Card.Title>
			<Card.Description>Changes to this transaction</Card.Description>
		</Card.Header>
		{#if data.history.length === 0}
			<Card.Content class="py-6 text-center">
				<p class="text-muted-foreground text-sm">No history yet.</p>
			</Card.Content>
		{:else}
			<Card.Content class="divide-border divide-y p-0">
				{#each data.history as entry (entry.id)}
					<div class="flex flex-col gap-1 px-6 py-3">
						<div class="flex items-start justify-between gap-2">
							<p class="min-w-0 text-sm">
								<span class="font-medium">{entry.actorName}</span>
								<span class="text-muted-foreground"> {actionLabel(entry.action)} </span>
							</p>
							<time
								datetime={entry.occurredAt}
								title={absoluteTime(entry.occurredAt)}
								class="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
							>
								{relativeTime(entry.occurredAt)}
							</time>
						</div>
						<p class="text-sm">{entry.summary}</p>
						<p class="text-muted-foreground text-xs">{absoluteTime(entry.occurredAt)}</p>
					</div>
				{/each}
			</Card.Content>
		{/if}
	</Card.Root>
</div>
