<script lang="ts" module>
	// Reusable transaction add/edit form (task 4.7; PLAN §7.1, §7.2, §7.3, §10).
	//
	// The SAME component backs the `new` page (task 4.7) and the future edit page
	// (task 4.11) — the parent owns the `superForm` instance (built from the SHARED
	// `buildTransactionSchema`) and the submit target; this component renders the
	// fields and drives the split-mode UI.
	//
	// SCOPE (4.7 + 4.8): spending & transfer; split_mode ∈ {equal, amount, share,
	// itemized}; a type toggle (Tabs) + a category picker (Select). Itemized (4.8)
	// adds a repeatable item-row UI (Spending only — §7.2.3). Charges (4.9) and the
	// FX / currency picker (4.10) are LATER tasks — this form leaves clean seams
	// (it submits empty charges, exchangeRate '1', amountTotalSettlement ==
	// amountTotal in the group's single currency).

	import type { SuperForm } from 'sveltekit-superforms';
	import type { TransactionInput } from '$lib/schemas/transaction';

	/** A selectable (active) member for the payer / beneficiary pickers. */
	export interface FormMember {
		id: string;
		displayName: string;
		isLinked: boolean;
	}

	/** A category option for the picker (id + display name + lucide icon name). */
	export interface FormCategory {
		id: string;
		name: string;
		icon: string;
	}

	/** The group's settlement currency descriptor (symbol + exponent for entry/format). */
	export interface FormCurrency {
		code: string;
		symbol: string;
		exponent: number;
	}

	export interface TransactionFormProps {
		/** The parent-owned superForm (built from `buildTransactionSchema`). */
		form: SuperForm<TransactionInput>;
		members: FormMember[];
		categories: { spending: FormCategory[]; transfer: FormCategory[] };
		currency: FormCurrency;
		/** Submit-button label (e.g. "Add transaction" / "Save changes"). */
		submitLabel?: string;
	}
</script>

<script lang="ts">
	import { formatAmount, parseAmount, type CurrencyCode } from '$lib/money';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CategoryIcon from '$lib/components/CategoryIcon.svelte';
	import { resolveItemizedShares } from '$lib/transactions/resolve';

	let {
		form,
		members,
		categories,
		currency,
		submitLabel = 'Add transaction'
	}: TransactionFormProps = $props();

	// The parent owns `form` for the component's lifetime; destructuring its stores
	// once at setup is the intended superForm usage (not a reactive re-read).
	// svelte-ignore state_referenced_locally
	const { form: formData, message, submitting, enhance, errors } = form;

	// The settlement currency is fixed for this form (4.7 single-currency), so
	// capturing it once is intentional.
	// svelte-ignore state_referenced_locally
	const currencyCode = currency.code as CurrencyCode;

	// The category set shown depends on the selected type (PLAN §7.3).
	const typeCategories = $derived(
		$formData.type === 'transfer' ? categories.transfer : categories.spending
	);

	// ── Amount entry (major-unit strings ↔ minor units) ──────────────────────────
	// Money is integer MINOR UNITS in the schema; the user types major-unit strings.
	// We keep a string for the total field and parse → minor units on input, mirror
	// it into `amountTotal` (and the single-currency `amountTotalSettlement`).
	let totalInput = $state(
		$formData.amountTotal > 0
			? formatAmount($formData.amountTotal, currencyCode, { symbol: false })
			: ''
	);

	// Per-member raw-amount inputs (split_mode = amount), keyed by member id.
	let amountInputs = $state<Record<string, string>>(
		Object.fromEntries(
			$formData.beneficiaries
				.filter((b) => b.rawAmount !== undefined)
				.map((b) => [b.memberId, formatAmount(b.rawAmount ?? 0, currencyCode, { symbol: false })])
		)
	);

	/** Parse a major-unit string → minor units; returns null on an invalid entry. */
	function toMinor(value: string): number | null {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		try {
			return parseAmount(trimmed, currencyCode);
		} catch {
			return null;
		}
	}

	// Keep the schema's `amountTotal` + single-currency `amountTotalSettlement` in
	// sync with the total. For non-itemized that's the typed total; for ITEMIZED the
	// total is DERIVED from the items subtotal (§7.2.1: amount_total == items_subtotal,
	// no charges in 4.8) — the user never types it. A single payer (the default)
	// mirrors the total into its `amountPaid` so `Σ amountPaid == amountTotal` holds.
	$effect(() => {
		const total = $formData.splitMode === 'itemized' ? itemsSubtotal : (toMinor(totalInput) ?? 0);
		$formData.amountTotal = total;
		// Single-currency (4.7): settlement total == txn total, rate 1.
		$formData.amountTotalSettlement = total;
		$formData.exchangeRate = '1';
		$formData.currency = currency.code;
		if ($formData.payers.length === 1) {
			$formData.payers[0].amountPaid = total;
		}
	});

	// ── Beneficiary selection ─────────────────────────────────────────────────────
	const selectedBeneficiaryIds = $derived(new Set($formData.beneficiaries.map((b) => b.memberId)));

	function toggleBeneficiary(memberId: string, checked: boolean) {
		if (checked) {
			if (!selectedBeneficiaryIds.has(memberId)) {
				$formData.beneficiaries = [...$formData.beneficiaries, beneficiaryFor(memberId)];
			}
		} else {
			$formData.beneficiaries = $formData.beneficiaries.filter((b) => b.memberId !== memberId);
		}
	}

	/** A fresh beneficiary line carrying the per-member input the current mode needs. */
	function beneficiaryFor(memberId: string): TransactionInput['beneficiaries'][number] {
		if ($formData.splitMode === 'share') {
			return { memberId, shareWeight: 1 };
		}
		if ($formData.splitMode === 'amount') {
			return { memberId, rawAmount: toMinor(amountInputs[memberId] ?? '') ?? 0 };
		}
		return { memberId };
	}

	// When the split mode changes, normalize every beneficiary line so it carries
	// the per-member input the new mode expects (weights for share, amounts for
	// amount, neither for equal). Keeps the payload valid as the UI switches.
	//
	// `itemized` (Spending only, §7.2.3): the beneficiaries live on the ITEMS, so the
	// top-level `beneficiaries` array is emptied; the item rows drive the split. We
	// seed one starter item if none exist yet so the UI has a row to edit.
	function onSplitModeChange(mode: TransactionInput['splitMode']) {
		$formData.splitMode = mode;
		if (mode === 'itemized') {
			$formData.beneficiaries = [];
			if ($formData.items.length === 0) {
				addItem();
			}
			return;
		}
		$formData.beneficiaries = $formData.beneficiaries.map((b) => {
			if (mode === 'share') return { memberId: b.memberId, shareWeight: b.shareWeight ?? 1 };
			if (mode === 'amount')
				return {
					memberId: b.memberId,
					rawAmount: toMinor(amountInputs[b.memberId] ?? '') ?? b.rawAmount ?? 0
				};
			return { memberId: b.memberId };
		});
	}

	function setShareWeight(memberId: string, raw: string) {
		const weight = Number.parseInt(raw, 10);
		$formData.beneficiaries = $formData.beneficiaries.map((b) =>
			b.memberId === memberId
				? { memberId, shareWeight: Number.isFinite(weight) && weight >= 0 ? weight : 0 }
				: b
		);
	}

	function setRawAmount(memberId: string, raw: string) {
		amountInputs[memberId] = raw;
		const minor = toMinor(raw) ?? 0;
		$formData.beneficiaries = $formData.beneficiaries.map((b) =>
			b.memberId === memberId ? { memberId, rawAmount: minor } : b
		);
	}

	// ── Payer selection ───────────────────────────────────────────────────────────
	const selectedPayerIds = $derived(new Set($formData.payers.map((p) => p.memberId)));

	function togglePayer(memberId: string, checked: boolean) {
		if (checked) {
			if (!selectedPayerIds.has(memberId)) {
				// New payer: 0 paid by default. A single payer is kept in sync with the
				// total by the effect above; with multiple payers the user enters each.
				$formData.payers = [...$formData.payers, { memberId, amountPaid: 0 }];
			}
		} else {
			$formData.payers = $formData.payers.filter((p) => p.memberId !== memberId);
		}
	}

	function setPaid(memberId: string, raw: string) {
		const minor = toMinor(raw) ?? 0;
		$formData.payers = $formData.payers.map((p) =>
			p.memberId === memberId ? { memberId, amountPaid: minor } : p
		);
	}

	function paidInputValue(memberId: string): string {
		const payer = $formData.payers.find((p) => p.memberId === memberId);
		return payer && payer.amountPaid > 0
			? formatAmount(payer.amountPaid, currencyCode, { symbol: false })
			: '';
	}

	const selectedCategoryName = $derived(
		typeCategories.find((c) => c.id === $formData.categoryId)?.name
	);

	// Whether to show the per-payer amount inputs: only with >1 selected payer (a
	// single payer is implicitly the whole total).
	const multiplePayers = $derived($formData.payers.length > 1);

	// ── Itemized split (PLAN §7.2.1 / §7.2.3 — task 4.8, Spending only) ───────────
	// Each item carries a label, an amount (major-unit string ↔ minor units), its
	// own split mode, and its beneficiaries. Item amount strings are kept in a
	// parallel array (index-aligned to `$formData.items`) so editing the display
	// string doesn't clobber the parsed minor-unit value mid-keystroke.
	type Item = TransactionInput['items'][number];

	// Whether itemized is available: SPENDING only (Transfers are never itemized).
	const itemizedAllowed = $derived($formData.type === 'spending');

	// Per-item amount display strings, index-aligned to `$formData.items`.
	let itemAmountInputs = $state<string[]>(
		$formData.items.map((it) =>
			it.amount > 0 ? formatAmount(it.amount, currencyCode, { symbol: false }) : ''
		)
	);

	// Per-item, per-member raw-amount display strings (split_mode='amount' items):
	// keyed `"<itemIndex>:<memberId>"`.
	let itemMemberAmountInputs = $state<Record<string, string>>({});

	/** The items subtotal (Σ item.amount), the itemized `amount_total` (no charges, 4.8). */
	const itemsSubtotal = $derived($formData.items.reduce((acc, it) => acc + it.amount, 0));

	/** Append a fresh empty item (label '', amount 0, equal split, no beneficiaries). */
	function addItem() {
		$formData.items = [
			...$formData.items,
			{ label: '', amount: 0, splitMode: 'equal', beneficiaries: [] }
		];
		itemAmountInputs = [...itemAmountInputs, ''];
	}

	/** Remove the item at `index` (and its parallel amount-string entry). */
	function removeItem(index: number) {
		$formData.items = $formData.items.filter((_, i) => i !== index);
		itemAmountInputs = itemAmountInputs.filter((_, i) => i !== index);
	}

	/** Patch a single item in place (immutably) and return the new items array. */
	function patchItem(index: number, patch: Partial<Item>) {
		$formData.items = $formData.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
	}

	function setItemLabel(index: number, label: string) {
		patchItem(index, { label });
	}

	function setItemAmount(index: number, raw: string) {
		itemAmountInputs[index] = raw;
		patchItem(index, { amount: toMinor(raw) ?? 0 });
	}

	/** Switch one item's split mode, normalizing its beneficiary lines (mirrors top-level). */
	function setItemSplitMode(index: number, mode: Item['splitMode']) {
		const item = $formData.items[index];
		const beneficiaries = item.beneficiaries.map((b) => {
			if (mode === 'share') return { memberId: b.memberId, shareWeight: b.shareWeight ?? 1 };
			if (mode === 'amount')
				return {
					memberId: b.memberId,
					rawAmount:
						toMinor(itemMemberAmountInputs[`${index}:${b.memberId}`] ?? '') ?? b.rawAmount ?? 0
				};
			return { memberId: b.memberId };
		});
		patchItem(index, { splitMode: mode, beneficiaries });
	}

	function itemHasBeneficiary(index: number, memberId: string): boolean {
		return $formData.items[index]?.beneficiaries.some((b) => b.memberId === memberId) ?? false;
	}

	/** A fresh per-item beneficiary line carrying the input the item's mode needs. */
	function itemBeneficiaryFor(index: number, memberId: string): Item['beneficiaries'][number] {
		const mode = $formData.items[index].splitMode;
		if (mode === 'share') return { memberId, shareWeight: 1 };
		if (mode === 'amount')
			return {
				memberId,
				rawAmount: toMinor(itemMemberAmountInputs[`${index}:${memberId}`] ?? '') ?? 0
			};
		return { memberId };
	}

	function toggleItemBeneficiary(index: number, memberId: string, checked: boolean) {
		const item = $formData.items[index];
		const beneficiaries = checked
			? item.beneficiaries.some((b) => b.memberId === memberId)
				? item.beneficiaries
				: [...item.beneficiaries, itemBeneficiaryFor(index, memberId)]
			: item.beneficiaries.filter((b) => b.memberId !== memberId);
		patchItem(index, { beneficiaries });
	}

	function setItemShareWeight(index: number, memberId: string, raw: string) {
		const weight = Number.parseInt(raw, 10);
		const beneficiaries = $formData.items[index].beneficiaries.map((b) =>
			b.memberId === memberId
				? { memberId, shareWeight: Number.isFinite(weight) && weight >= 0 ? weight : 0 }
				: b
		);
		patchItem(index, { beneficiaries });
	}

	function setItemRawAmount(index: number, memberId: string, raw: string) {
		itemMemberAmountInputs[`${index}:${memberId}`] = raw;
		const minor = toMinor(raw) ?? 0;
		const beneficiaries = $formData.items[index].beneficiaries.map((b) =>
			b.memberId === memberId ? { memberId, rawAmount: minor } : b
		);
		patchItem(index, { beneficiaries });
	}

	function itemShareWeightValue(index: number, memberId: string): number {
		return (
			$formData.items[index]?.beneficiaries.find((b) => b.memberId === memberId)?.shareWeight ?? 1
		);
	}

	// Optional live per-member breakdown for the itemized split (the resolver is
	// client-importable). Best-effort: only computed when every item is currently
	// valid (amount>0, ≥1 beneficiary, its own split adds up), else null (the full
	// breakdown / charges UI is task 4.9).
	const itemizedBreakdown = $derived.by(() => {
		if ($formData.splitMode !== 'itemized' || $formData.items.length === 0) return null;
		try {
			return resolveItemizedShares($formData.items).shares;
		} catch {
			return null;
		}
	});

	function memberName(memberId: string): string {
		return members.find((m) => m.id === memberId)?.displayName ?? memberId;
	}
</script>

<form method="POST" use:enhance class="space-y-6">
	{#if $message?.type === 'error'}
		<p class="text-destructive text-sm" role="alert">{$message.text}</p>
	{/if}

	<!-- Hidden mirrors of the schema's single-currency / FX fields (4.10 surfaces
	     these). They keep the payload complete + valid without JS. -->
	<input type="hidden" name="amountTotal" value={$formData.amountTotal} />
	<input type="hidden" name="amountTotalSettlement" value={$formData.amountTotalSettlement} />
	<input type="hidden" name="exchangeRate" value={$formData.exchangeRate} />
	<input type="hidden" name="currency" value={$formData.currency} />
	<input type="hidden" name="splitMode" value={$formData.splitMode} />
	<input type="hidden" name="type" value={$formData.type} />
	<input type="hidden" name="categoryId" value={$formData.categoryId} />

	<!-- Type toggle (PLAN §7.1) — shadcn Tabs: spending / transfer. -->
	<div class="space-y-2">
		<Label>Type</Label>
		<Tabs.Root
			value={$formData.type}
			onValueChange={(v) => {
				$formData.type = v as 'spending' | 'transfer';
				// Reset the category to the first one in the new type's set (§7.3).
				$formData.categoryId =
					(v === 'transfer' ? categories.transfer : categories.spending)[0]?.id ?? '';
				// Transfers are never itemized (§7.2.3): fall back to an equal split.
				if (v === 'transfer' && $formData.splitMode === 'itemized') {
					onSplitModeChange('equal');
				}
			}}
		>
			<Tabs.List class="grid w-full grid-cols-2">
				<Tabs.Trigger value="spending">Spending</Tabs.Trigger>
				<Tabs.Trigger value="transfer">Transfer</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
	</div>

	<!-- Title -->
	<div class="space-y-2">
		<Label for="title">Title</Label>
		<Input
			id="title"
			name="title"
			type="text"
			placeholder={$formData.type === 'transfer' ? 'Settle up' : 'Dinner'}
			bind:value={$formData.title}
		/>
		{#if $errors.title}<p class="text-destructive text-sm">{$errors.title}</p>{/if}
	</div>

	<!-- Category picker (PLAN §7.3) — shadcn Select filtered by type. The hidden
	     input above carries the value for no-JS; the Select drives it with JS. -->
	<div class="space-y-2">
		<Label>Category</Label>
		<Select.Root type="single" bind:value={$formData.categoryId}>
			<Select.Trigger class="w-full">
				<span class="flex items-center gap-2">
					{#if $formData.categoryId}
						<CategoryIcon
							name={typeCategories.find((c) => c.id === $formData.categoryId)?.icon ?? 'shapes'}
							class="size-4"
						/>
					{/if}
					{selectedCategoryName ?? 'Select a category'}
				</span>
			</Select.Trigger>
			<Select.Content>
				{#each typeCategories as category (category.id)}
					<Select.Item value={category.id} label={category.name}>
						<CategoryIcon name={category.icon} class="size-4" />
						{category.name}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		{#if $errors.categoryId}<p class="text-destructive text-sm">{$errors.categoryId}</p>{/if}
	</div>

	<!-- Total amount. For non-itemized the user types it (major units → minor units).
	     For itemized the total is DERIVED from the items subtotal (§7.2.1), shown
	     read-only — the item rows below drive it. -->
	<div class="space-y-2">
		<Label for="amountTotal">Amount</Label>
		{#if $formData.splitMode === 'itemized'}
			<div class="flex items-center justify-between gap-2">
				<span class="text-muted-foreground text-sm">Items subtotal</span>
				<span class="font-medium">{formatAmount(itemsSubtotal, currencyCode)}</span>
			</div>
		{:else}
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground text-sm">{currency.symbol}</span>
				<Input
					id="amountTotal"
					inputmode="decimal"
					placeholder="0.00"
					bind:value={totalInput}
					class="flex-1"
				/>
			</div>
		{/if}
		{#if $errors.amountTotal}<p class="text-destructive text-sm">{$errors.amountTotal}</p>{/if}
	</div>

	<!-- Paid by (member multi-select). Default = the acting user's member, paying
	     the whole total. With >1 payer, per-payer amounts show (Σ == total). -->
	<fieldset class="space-y-2">
		<legend class="text-sm font-medium">Paid by</legend>
		<div class="space-y-2">
			{#each members as member (member.id)}
				{@const isPayer = selectedPayerIds.has(member.id)}
				<div class="flex items-center justify-between gap-2">
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={isPayer}
							onchange={(e) => togglePayer(member.id, e.currentTarget.checked)}
							class="size-4"
						/>
						{member.displayName}
					</label>
					{#if isPayer && multiplePayers}
						<div class="flex items-center gap-1">
							<span class="text-muted-foreground text-xs">{currency.symbol}</span>
							<Input
								inputmode="decimal"
								placeholder="0.00"
								value={paidInputValue(member.id)}
								oninput={(e) => setPaid(member.id, e.currentTarget.value)}
								class="h-8 w-24"
							/>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if $errors.payers?._errors}
			<p class="text-destructive text-sm">{$errors.payers._errors}</p>
		{/if}
	</fieldset>

	<!-- Split mode (PLAN §7.2): equal / amount / share, plus `itemized` (§7.2.1) for
	     SPENDING only (Transfers are never itemized, §7.2.3). -->
	<div class="space-y-2">
		<Label>Split</Label>
		<Tabs.Root
			value={$formData.splitMode}
			onValueChange={(v) => onSplitModeChange(v as TransactionInput['splitMode'])}
		>
			<Tabs.List class="grid w-full {itemizedAllowed ? 'grid-cols-4' : 'grid-cols-3'}">
				<Tabs.Trigger value="equal">Equal</Tabs.Trigger>
				<Tabs.Trigger value="amount">Amount</Tabs.Trigger>
				<Tabs.Trigger value="share">Share</Tabs.Trigger>
				{#if itemizedAllowed}
					<Tabs.Trigger value="itemized">Itemized</Tabs.Trigger>
				{/if}
			</Tabs.List>
		</Tabs.Root>
	</div>

	{#if $formData.splitMode !== 'itemized'}
		<!-- Beneficiaries (member multi-select). The per-member inputs depend on the
		     split mode: none (equal), an amount (amount), a weight (share). -->
		<fieldset class="space-y-2">
			<legend class="text-sm font-medium">Split between</legend>
			<div class="space-y-2">
				{#each members as member (member.id)}
					{@const isBeneficiary = selectedBeneficiaryIds.has(member.id)}
					<div class="flex items-center justify-between gap-2">
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={isBeneficiary}
								onchange={(e) => toggleBeneficiary(member.id, e.currentTarget.checked)}
								class="size-4"
							/>
							{member.displayName}
						</label>
						{#if isBeneficiary && $formData.splitMode === 'amount'}
							<div class="flex items-center gap-1">
								<span class="text-muted-foreground text-xs">{currency.symbol}</span>
								<Input
									inputmode="decimal"
									placeholder="0.00"
									value={amountInputs[member.id] ?? ''}
									oninput={(e) => setRawAmount(member.id, e.currentTarget.value)}
									class="h-8 w-24"
								/>
							</div>
						{:else if isBeneficiary && $formData.splitMode === 'share'}
							<Input
								inputmode="numeric"
								placeholder="1"
								value={$formData.beneficiaries.find((b) => b.memberId === member.id)?.shareWeight ??
									1}
								oninput={(e) => setShareWeight(member.id, e.currentTarget.value)}
								class="h-8 w-20"
							/>
						{/if}
					</div>
				{/each}
			</div>
			{#if $errors.beneficiaries?._errors}
				<p class="text-destructive text-sm">{$errors.beneficiaries._errors}</p>
			{/if}
		</fieldset>
	{:else}
		<!-- Itemized items (PLAN §7.2.1, task 4.8): a repeatable list of item rows.
		     Each item has a label, an amount, its beneficiaries, and a per-item split
		     mode (equal/amount/share). amount_total == Σ item.amount (no charges, 4.8;
		     the charges section + full discount→service→VAT breakdown are task 4.9). -->
		<fieldset class="space-y-4">
			<legend class="text-sm font-medium">Items</legend>
			{#each $formData.items as item, index (index)}
				<div class="space-y-3 rounded-md border p-3">
					<div class="flex items-end gap-2">
						<div class="flex-1 space-y-1">
							<Label for="item-{index}-label">Item</Label>
							<Input
								id="item-{index}-label"
								type="text"
								placeholder="e.g. Pizza"
								value={item.label}
								oninput={(e) => setItemLabel(index, e.currentTarget.value)}
							/>
						</div>
						<div class="w-28 space-y-1">
							<Label for="item-{index}-amount">Amount</Label>
							<div class="flex items-center gap-1">
								<span class="text-muted-foreground text-xs">{currency.symbol}</span>
								<Input
									id="item-{index}-amount"
									inputmode="decimal"
									placeholder="0.00"
									value={itemAmountInputs[index] ?? ''}
									oninput={(e) => setItemAmount(index, e.currentTarget.value)}
								/>
							</div>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onclick={() => removeItem(index)}
							disabled={$formData.items.length <= 1}
							aria-label="Remove item"
						>
							Remove
						</Button>
					</div>

					<!-- Per-item split mode (equal/amount/share). -->
					<Tabs.Root
						value={item.splitMode}
						onValueChange={(v) => setItemSplitMode(index, v as Item['splitMode'])}
					>
						<Tabs.List class="grid w-full grid-cols-3">
							<Tabs.Trigger value="equal">Equal</Tabs.Trigger>
							<Tabs.Trigger value="amount">Amount</Tabs.Trigger>
							<Tabs.Trigger value="share">Share</Tabs.Trigger>
						</Tabs.List>
					</Tabs.Root>

					<!-- Per-item beneficiaries + the per-item-mode input. -->
					<div class="space-y-2">
						{#each members as member (member.id)}
							{@const isBeneficiary = itemHasBeneficiary(index, member.id)}
							<div class="flex items-center justify-between gap-2">
								<label class="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={isBeneficiary}
										onchange={(e) =>
											toggleItemBeneficiary(index, member.id, e.currentTarget.checked)}
										class="size-4"
									/>
									{member.displayName}
								</label>
								{#if isBeneficiary && item.splitMode === 'amount'}
									<div class="flex items-center gap-1">
										<span class="text-muted-foreground text-xs">{currency.symbol}</span>
										<Input
											inputmode="decimal"
											placeholder="0.00"
											value={itemMemberAmountInputs[`${index}:${member.id}`] ?? ''}
											oninput={(e) => setItemRawAmount(index, member.id, e.currentTarget.value)}
											class="h-8 w-24"
										/>
									</div>
								{:else if isBeneficiary && item.splitMode === 'share'}
									<Input
										inputmode="numeric"
										placeholder="1"
										value={itemShareWeightValue(index, member.id)}
										oninput={(e) => setItemShareWeight(index, member.id, e.currentTarget.value)}
										class="h-8 w-20"
									/>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}

			<Button type="button" variant="outline" size="sm" onclick={addItem}>Add item</Button>

			{#if $errors.items?._errors}
				<p class="text-destructive text-sm">{$errors.items._errors}</p>
			{/if}

			<!-- Optional live per-member breakdown (the resolver is client-importable).
			     The full charges breakdown is task 4.9. -->
			{#if itemizedBreakdown && itemizedBreakdown.length > 0}
				<div class="space-y-1 border-t pt-3 text-sm">
					<p class="font-medium">Each person owes</p>
					{#each itemizedBreakdown as share (share.memberId)}
						<div class="flex items-center justify-between">
							<span>{memberName(share.memberId)}</span>
							<span>{formatAmount(share.amountOwed, currencyCode)}</span>
						</div>
					{/each}
				</div>
			{/if}
		</fieldset>
	{/if}

	<!-- Serialize the (array) payers + beneficiaries for the no-JS POST. superForm's
	     `enhance` re-serializes from `$formData` with JS; these hidden inputs ensure
	     the nested arrays still reach the action when JS is off. -->
	{#each $formData.payers as payer, i (payer.memberId)}
		<input type="hidden" name="payers[{i}].memberId" value={payer.memberId} />
		<input type="hidden" name="payers[{i}].amountPaid" value={payer.amountPaid} />
	{/each}
	{#each $formData.beneficiaries as beneficiary, i (beneficiary.memberId)}
		<input type="hidden" name="beneficiaries[{i}].memberId" value={beneficiary.memberId} />
		{#if beneficiary.rawAmount !== undefined}
			<input type="hidden" name="beneficiaries[{i}].rawAmount" value={beneficiary.rawAmount} />
		{/if}
		{#if beneficiary.shareWeight !== undefined}
			<input type="hidden" name="beneficiaries[{i}].shareWeight" value={beneficiary.shareWeight} />
		{/if}
	{/each}
	<!-- Itemized items (no-JS fallback). superForm `enhance` re-serializes from
	     `$formData` with JS; these carry the nested item arrays when JS is off. -->
	{#each $formData.items as item, i (i)}
		<input type="hidden" name="items[{i}].label" value={item.label} />
		<input type="hidden" name="items[{i}].amount" value={item.amount} />
		<input type="hidden" name="items[{i}].splitMode" value={item.splitMode} />
		{#each item.beneficiaries as b, j (b.memberId)}
			<input type="hidden" name="items[{i}].beneficiaries[{j}].memberId" value={b.memberId} />
			{#if b.rawAmount !== undefined}
				<input type="hidden" name="items[{i}].beneficiaries[{j}].rawAmount" value={b.rawAmount} />
			{/if}
			{#if b.shareWeight !== undefined}
				<input
					type="hidden"
					name="items[{i}].beneficiaries[{j}].shareWeight"
					value={b.shareWeight}
				/>
			{/if}
		{/each}
	{/each}

	<Button type="submit" class="w-full" disabled={$submitting}>
		{$submitting ? 'Saving…' : submitLabel}
	</Button>
</form>
