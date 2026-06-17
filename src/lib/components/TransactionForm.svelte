<script lang="ts" module>
	// Reusable transaction add/edit form (task 4.7; PLAN §7.1, §7.2, §7.3, §10).
	//
	// The SAME component backs the `new` page (task 4.7) and the future edit page
	// (task 4.11) — the parent owns the `superForm` instance (built from the SHARED
	// `buildTransactionSchema`) and the submit target; this component renders the
	// fields and drives the split-mode UI.
	//
	// SCOPE (4.7): spending & transfer; split_mode ∈ {equal, amount, share}; a type
	// toggle (Tabs) + a category picker (Select). Itemized (4.8), charges (4.9), and
	// the FX / currency picker (4.10) are LATER tasks — this form leaves clean seams
	// (it submits empty items/charges, exchangeRate '1', amountTotalSettlement ==
	// amountTotal in the group's single currency). The `splitMode` set offered here
	// is exactly {equal, amount, share}; 4.8 adds `itemized`.

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
	// sync with the typed total. A single payer (the default) also mirrors the total
	// into its `amountPaid` so `Σ amountPaid == amountTotal` holds out of the box.
	$effect(() => {
		const minor = toMinor(totalInput);
		const total = minor ?? 0;
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
	function onSplitModeChange(mode: 'equal' | 'amount' | 'share') {
		$formData.splitMode = mode;
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

	<!-- Total amount (major units entry → minor units in the schema) -->
	<div class="space-y-2">
		<Label for="amountTotal">Amount</Label>
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

	<!-- Split mode (PLAN §7.2): equal / amount / share. Itemized is task 4.8. -->
	<div class="space-y-2">
		<Label>Split</Label>
		<Tabs.Root
			value={$formData.splitMode}
			onValueChange={(v) => onSplitModeChange(v as 'equal' | 'amount' | 'share')}
		>
			<Tabs.List class="grid w-full grid-cols-3">
				<Tabs.Trigger value="equal">Equal</Tabs.Trigger>
				<Tabs.Trigger value="amount">Amount</Tabs.Trigger>
				<Tabs.Trigger value="share">Share</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
	</div>

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

	<Button type="submit" class="w-full" disabled={$submitting}>
		{$submitting ? 'Saving…' : submitLabel}
	</Button>
</form>
