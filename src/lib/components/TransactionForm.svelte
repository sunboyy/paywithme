<script lang="ts" module>
	// Reusable transaction add/edit form (task 4.7; PLAN §7.1, §7.2, §7.3, §10).
	//
	// The SAME component backs the `new` page (task 4.7) and the future edit page
	// (task 4.11) — the parent owns the `superForm` instance (built from the SHARED
	// `buildTransactionSchema`) and the submit target; this component renders the
	// fields and drives the split-mode UI.
	//
	// SCOPE (4.7–4.10): spending & transfer; split_mode ∈ {equal, amount, share,
	// itemized}; a type toggle (Tabs) + a category picker (Select). Itemized (4.8)
	// adds a repeatable item-row UI (Spending only — §7.2.3). Charges (4.9) add a
	// repeatable charge-row section + a live computed breakdown (items subtotal →
	// ± each charge → total, plus each member's resolved final share). FX (4.10) adds
	// a currency picker (default = group settlement currency); choosing a DIFFERENT
	// currency reveals a rate / settlement-total entry (enter EITHER; the other is
	// derived) with a live converted total, and recomputes `amountTotalSettlement`
	// from the rate. Same-currency stays the no-op seam (rate '1', settlement == txn).

	import type { SuperForm } from 'sveltekit-superforms';
	import type { TransactionInput, ChargeInput } from '$lib/schemas/transaction';

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

	/** A currency descriptor (symbol + exponent for entry/format). */
	export interface FormCurrency {
		code: string;
		symbol: string;
		exponent: number;
		/** Optional display name (shown in the FX currency picker). */
		name?: string;
	}

	export interface TransactionFormProps {
		/** The parent-owned superForm (built from `buildTransactionSchema`). */
		form: SuperForm<TransactionInput>;
		members: FormMember[];
		categories: { spending: FormCategory[]; transfer: FormCategory[] };
		/** The group's SETTLEMENT currency (the default + what balances are shown in). */
		currency: FormCurrency;
		/**
		 * The supported currencies for the FX picker (§7.6). Defaults to just the
		 * settlement currency when omitted, so a single-currency caller keeps working.
		 */
		currencies?: FormCurrency[];
		/** Submit-button label (e.g. "Add transaction" / "Save changes"). */
		submitLabel?: string;
		/**
		 * Optional form `action` target (e.g. `'?/edit'` for the edit page). Omitted →
		 * posts to the route's default action (the `new` page). Progressive enhancement
		 * keeps the nested-array payload reaching the named action without JS too.
		 */
		action?: string;
	}
</script>

<script lang="ts">
	import { formatAmount, parseAmount, type CurrencyCode } from '$lib/money';
	import { applyCharges, convertToSettlement } from '$lib/schemas/transaction';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CategoryIcon from '$lib/components/CategoryIcon.svelte';
	import { resolveItemizedWithCharges, distributeToSettlement } from '$lib/transactions/resolve';

	let {
		form,
		members,
		categories,
		currency,
		currencies,
		submitLabel = 'Add transaction',
		action
	}: TransactionFormProps = $props();

	// The parent owns `form` for the component's lifetime; destructuring its stores
	// once at setup is the intended superForm usage (not a reactive re-read).
	// svelte-ignore state_referenced_locally
	const { form: formData, message, submitting, enhance, errors } = form;

	// The group's SETTLEMENT currency — the default entry currency and what balances
	// are denominated in. Fixed for this form's lifetime; capturing once is intentional.
	// svelte-ignore state_referenced_locally
	const settlementCode = currency.code as CurrencyCode;

	// The supported-currency list for the FX picker (§7.6). Falls back to just the
	// settlement currency so a single-currency caller (no `currencies` prop) still works.
	// Props don't change after hydration, so capturing them once here is intentional.
	// svelte-ignore state_referenced_locally
	const currencyOptions: FormCurrency[] =
		currencies && currencies.length > 0 ? currencies : [currency];

	// ── FX state (PLAN §7.6) ──────────────────────────────────────────────────────
	// The chosen ENTRY currency (the txn currency). Defaults to the group settlement
	// currency; choosing a DIFFERENT one reveals the rate / settlement-total entry.
	let entryCode = $state(($formData.currency as CurrencyCode) || settlementCode);

	// Whether the chosen entry currency is FOREIGN (≠ settlement) — drives the FX UI.
	const isForeign = $derived(entryCode !== settlementCode);

	// The descriptor for the CHOSEN entry currency (symbol/exponent for amount entry).
	const entryCurrency = $derived(currencyOptions.find((c) => c.code === entryCode) ?? currency);
	// `entryCode` is what every amount field on the form is denominated in.
	const currencyCode = $derived(entryCode);

	// The FX rate string (settlement units per 1 entry unit, ≤6dp). For a foreign
	// currency the user types EITHER this OR the settlement-equivalent total below;
	// the other is derived. Held as a display string (separate from the parsed schema
	// value) so editing doesn't clobber mid-keystroke. `''` until the user enters one.
	let rateInput = $state(isForeignInitial() ? ($formData.exchangeRate ?? '') : '');
	// The settlement-equivalent total display string (the alternative FX entry).
	let settlementTotalInput = $state('');
	// Which field the user last edited drives the derivation direction (the OTHER is
	// computed). 'rate' → derive settlement total; 'total' → derive the rate.
	let fxDriver = $state<'rate' | 'total'>('rate');

	function isForeignInitial(): boolean {
		return (($formData.currency as string) || settlementCode) !== settlementCode;
	}

	// The category set shown depends on the selected type (PLAN §7.3).
	const typeCategories = $derived(
		$formData.type === 'transfer' ? categories.transfer : categories.spending
	);

	// ── Amount entry (major-unit strings ↔ minor units) ──────────────────────────
	// Money is integer MINOR UNITS in the schema; the user types major-unit strings.
	// We keep a string for the total field and parse → minor units on input, mirror
	// it into `amountTotal` (and `amountTotalSettlement`). The initial display string
	// is captured once from the seeded currency — intentional (the effect keeps it live).
	// svelte-ignore state_referenced_locally
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

	// ── FX rate / settlement-total derivation (PLAN §7.6) ─────────────────────────
	// Normalize a typed rate string to the `numeric(18,6)` shape the schema validates
	// (≤6 fractional digits, positive). Returns null when it isn't a usable rate.
	function normalizeRate(raw: string): string | null {
		const trimmed = raw.trim();
		if (trimmed === '') return null;
		if (!/^\d{1,12}(?:\.\d+)?$/.test(trimmed)) return null;
		const n = Number(trimmed);
		if (!Number.isFinite(n) || n <= 0) return null;
		// Clamp to ≤6 dp (the numeric(18,6) envelope) without float drift.
		const [intPart, fracPart = ''] = trimmed.split('.');
		const frac = fracPart.slice(0, 6).replace(/0+$/, '');
		return frac === '' ? intPart : `${intPart}.${frac}`;
	}

	// The CURRENT effective rate string for the chosen entry currency. Same currency →
	// always '1' (§7.6). Foreign + driver 'rate' → the typed rate. Foreign + driver
	// 'total' → derived from settlement_total / txn_total (in minor units, exact-ish).
	const effectiveRate = $derived.by<string | null>(() => {
		if (!isForeign) return '1';
		const txnMinor =
			$formData.splitMode === 'itemized' ? itemizedTotal : (toMinor(totalInput) ?? 0);
		if (fxDriver === 'rate') {
			return normalizeRate(rateInput);
		}
		// driver 'total': rate = settlement_total / txn_total. Need both totals > 0.
		const stlMinor = parseSettlement(settlementTotalInput);
		if (stlMinor === null || txnMinor <= 0) return null;
		// Convert minor→major-unit ratio: (stl/10^expStl) / (txn/10^expTxn).
		const expTxn = entryCurrency.exponent;
		const expStl = currency.exponent;
		const rate = stlMinor / 10 ** expStl / (txnMinor / 10 ** expTxn);
		return normalizeRate(rate.toFixed(6));
	});

	/** Parse the settlement-equivalent total string → settlement-currency minor units. */
	function parseSettlement(value: string): number | null {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		try {
			return parseAmount(trimmed, settlementCode);
		} catch {
			return null;
		}
	}

	// Keep the schema's `amountTotal`, `currency`, `exchangeRate`, and
	// `amountTotalSettlement` in sync. For non-itemized the total is the typed value;
	// for ITEMIZED it's DERIVED (§7.2.2). When the entry currency == settlement the
	// rate is forced to '1' and the settlement total == txn total (no-op). When it's
	// FOREIGN, the settlement total is RECOMPUTED from the effective rate via
	// `convertToSettlement` so it stays consistent with what the schema validates
	// (§7.6: stored canonical = the rate + the recomputed settlement total). A single
	// payer (the default) mirrors the total so `Σ amountPaid == amountTotal` holds.
	$effect(() => {
		const total = $formData.splitMode === 'itemized' ? itemizedTotal : (toMinor(totalInput) ?? 0);

		let nextRate: string;
		let nextSettlement: number;
		if (!isForeign) {
			nextRate = '1';
			nextSettlement = total;
		} else {
			const rate = effectiveRate;
			nextRate = rate ?? '';
			// Recompute the canonical settlement total from the rate (consistent with
			// the §7.6 scalar the schema checks). When the rate isn't valid yet, leave
			// the settlement total at the txn total as a placeholder (the schema will
			// reject the invalid rate, surfacing the error before save).
			nextSettlement =
				rate !== null ? convertToSettlement(total, entryCode, settlementCode, rate) : total;
		}

		// Guard EVERY write with an equality check so this effect is idempotent. It
		// reads `$formData` (subscribing to the superForm store) and writes back to it;
		// superForm's store notifies subscribers on every write, so an UNCONDITIONAL
		// write would re-trigger this effect forever → `effect_update_depth_exceeded`
		// (the page froze on mount). Writing only on an actual change lets the effect
		// settle once the derived values match the form state.
		if ($formData.amountTotal !== total) $formData.amountTotal = total;
		if ($formData.currency !== entryCode) $formData.currency = entryCode;
		if ($formData.exchangeRate !== nextRate) $formData.exchangeRate = nextRate;
		if ($formData.amountTotalSettlement !== nextSettlement) {
			$formData.amountTotalSettlement = nextSettlement;
		}
		if ($formData.payers.length === 1 && $formData.payers[0].amountPaid !== total) {
			$formData.payers = [{ ...$formData.payers[0], amountPaid: total }];
		}
	});

	// The live converted total (e.g. "¥200 → ฿970") shown under the FX entry (§7.6/§10).
	const settlementPreview = $derived.by(() => {
		if (!isForeign) return null;
		const rate = effectiveRate;
		const total = $formData.splitMode === 'itemized' ? itemizedTotal : (toMinor(totalInput) ?? 0);
		if (rate === null || total <= 0) return null;
		try {
			const stl = convertToSettlement(total, entryCode, settlementCode, rate);
			return { txn: formatAmount(total, entryCode), settlement: formatAmount(stl, settlementCode) };
		} catch {
			return null;
		}
	});

	/** Switch the entry currency. Back to settlement → clear the rate to 1 (§7.6). */
	function onCurrencyChange(code: string) {
		entryCode = code as CurrencyCode;
		if (code === settlementCode) {
			rateInput = '';
			settlementTotalInput = '';
			fxDriver = 'rate';
		}
	}

	function onRateInput(raw: string) {
		fxDriver = 'rate';
		rateInput = raw;
	}

	function onSettlementTotalInput(raw: string) {
		fxDriver = 'total';
		settlementTotalInput = raw;
	}

	const selectedCurrencyLabel = $derived(
		`${entryCurrency.code}${entryCurrency.name ? ` · ${entryCurrency.name}` : ''}`
	);

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
		// Charges apply to itemized only (§7.2.3); clear them when leaving itemized so
		// the non-itemized payload stays valid (charges would otherwise be ignored).
		$formData.charges = [];
		chargeValueInputs = [];
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

	/** The items subtotal (Σ item.amount). */
	const itemsSubtotal = $derived($formData.items.reduce((acc, it) => acc + it.amount, 0));

	// ── Charges / discounts (PLAN §7.2.2 — task 4.9, itemized Spending only) ──────
	// Each charge row: kind (service/vat/discount), mode (percent/absolute), value
	// (percent entered as % → basis points; absolute parsed via lib/money → minor
	// units), base (items_subtotal/running_total), and sort_order (application order).
	// The display strings are kept index-aligned so editing them doesn't clobber the
	// parsed value mid-keystroke.
	const CHARGE_KINDS = [
		{ value: 'service', label: 'Service charge' },
		{ value: 'vat', label: 'VAT / Tax' },
		{ value: 'discount', label: 'Discount' }
	] as const;
	const CHARGE_MODES = [
		{ value: 'percent', label: 'Percent (%)' },
		{ value: 'absolute', label: 'Fixed amount' }
	] as const;
	const CHARGE_BASES = [
		{ value: 'items_subtotal', label: 'Items subtotal' },
		{ value: 'running_total', label: 'Running total' }
	] as const;

	// Per-charge display strings, index-aligned to `$formData.charges`. For a percent
	// charge this is the % string (e.g. "10" for 1000 bps); for absolute it is the
	// major-unit string (parsed via lib/money). Kept separate from the parsed value.
	let chargeValueInputs = $state<string[]>(
		$formData.charges.map((c) =>
			c.mode === 'percent'
				? c.value > 0
					? String(c.value / 100)
					: ''
				: c.value > 0
					? formatAmount(c.value, currencyCode, { symbol: false })
					: ''
		)
	);

	/** The itemized total = items subtotal + Σ signed charges (§7.2.2). Best-effort. */
	const itemizedTotal = $derived.by(() => {
		try {
			return applyCharges(itemsSubtotal, $formData.charges).amountTotal;
		} catch {
			return itemsSubtotal;
		}
	});

	/** Parse one charge's display string → its stored value (bps for percent, minor for absolute). */
	function parseChargeValue(mode: ChargeInput['mode'], raw: string): number {
		const trimmed = raw.trim();
		if (trimmed === '') return 0;
		if (mode === 'percent') {
			// Percent entered as a % number → basis points (10% → 1000). Round to the
			// nearest integer bps; clamp to the schema's 0–10000 range.
			const pct = Number(trimmed);
			if (!Number.isFinite(pct) || pct < 0) return 0;
			return Math.min(10000, Math.round(pct * 100));
		}
		return toMinor(trimmed) ?? 0;
	}

	/** Append a fresh charge (10% VAT default), next sort_order. */
	function addCharge() {
		const sortOrder = $formData.charges.length;
		$formData.charges = [
			...$formData.charges,
			{ kind: 'service', mode: 'percent', value: 0, base: 'items_subtotal', sortOrder }
		];
		chargeValueInputs = [...chargeValueInputs, ''];
	}

	/** Remove the charge at `index`, re-densifying sort_order to keep it contiguous. */
	function removeCharge(index: number) {
		$formData.charges = $formData.charges
			.filter((_, i) => i !== index)
			.map((c, i) => ({ ...c, sortOrder: i }));
		chargeValueInputs = chargeValueInputs.filter((_, i) => i !== index);
	}

	/** Patch one charge in place (immutably). */
	function patchCharge(index: number, patch: Partial<ChargeInput>) {
		$formData.charges = $formData.charges.map((c, i) => (i === index ? { ...c, ...patch } : c));
	}

	function setChargeKind(index: number, kind: ChargeInput['kind']) {
		patchCharge(index, { kind });
	}

	function setChargeMode(index: number, mode: ChargeInput['mode']) {
		// Re-parse the existing display string under the new mode so the stored value
		// stays consistent (a "10" means 1000 bps as percent, ฿0.10 as absolute).
		patchCharge(index, { mode, value: parseChargeValue(mode, chargeValueInputs[index] ?? '') });
	}

	function setChargeBase(index: number, base: ChargeInput['base']) {
		patchCharge(index, { base });
	}

	function setChargeValue(index: number, raw: string) {
		chargeValueInputs[index] = raw;
		patchCharge(index, { value: parseChargeValue($formData.charges[index].mode, raw) });
	}

	function chargeKindLabel(kind: string): string {
		return CHARGE_KINDS.find((k) => k.value === kind)?.label ?? kind;
	}

	function chargeModeLabel(mode: string): string {
		return CHARGE_MODES.find((m) => m.value === mode)?.label ?? mode;
	}

	function chargeBaseLabel(base: string): string {
		return CHARGE_BASES.find((b) => b.value === base)?.label ?? base;
	}

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

	// Live computed breakdown for the itemized split + charges (§7.2.2 / §7.2.3 / §10):
	// items subtotal → (in sort order) ± each resolved charge → total, PLUS each
	// member's resolved FINAL share — all client-side via the client-importable
	// resolver so the user sees who owes what BEFORE saving. Best-effort: only
	// computed when every item is currently valid (amount>0, ≥1 beneficiary, its own
	// split adds up), else null.
	const itemizedBreakdown = $derived.by(() => {
		if ($formData.splitMode !== 'itemized' || $formData.items.length === 0) return null;
		try {
			return resolveItemizedWithCharges($formData.items, $formData.charges);
		} catch {
			return null;
		}
	});

	function memberName(memberId: string): string {
		return members.find((m) => m.id === memberId)?.displayName ?? memberId;
	}

	// Per-member SETTLEMENT-converted owed for the itemized breakdown (§7.6): convert
	// the txn total once, then distribute across members by their txn-currency owed —
	// the SAME convert-then-distribute the service persists. Null when not foreign or
	// the breakdown/rate isn't ready.
	const settlementShares = $derived.by(() => {
		if (!isForeign || !itemizedBreakdown) return null;
		const stl = $formData.amountTotalSettlement;
		if (stl <= 0) return null;
		try {
			return new Map(
				distributeToSettlement(
					itemizedBreakdown.shares.map((s) => ({ memberId: s.memberId, amount: s.amountOwed })),
					stl
				).map((s) => [s.memberId, s.amountOwed])
			);
		} catch {
			return null;
		}
	});
</script>

<form method="POST" {action} use:enhance class="space-y-6">
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

	<!-- Currency picker (PLAN §7.6): defaults to the group settlement currency.
	     Choosing a DIFFERENT currency reveals the FX (rate / settlement-total) entry. -->
	<div class="space-y-2">
		<Label>Currency</Label>
		<Select.Root type="single" value={entryCode} onValueChange={onCurrencyChange}>
			<Select.Trigger class="w-full">{selectedCurrencyLabel}</Select.Trigger>
			<Select.Content>
				{#each currencyOptions as option (option.code)}
					<Select.Item value={option.code} label={option.code}>
						{option.code}{option.name ? ` · ${option.name}` : ''}
						{#if option.code === settlementCode}
							<span class="text-muted-foreground text-xs">(group)</span>
						{/if}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>

	<!-- FX entry (PLAN §7.6 / §10) — only when the entry currency is FOREIGN. Enter
	     EITHER the exchange rate OR the settlement-equivalent total; the other is
	     derived, with a live converted total shown (e.g. "¥200 → ฿970"). -->
	{#if isForeign}
		<div class="space-y-3 rounded-md border p-3">
			<p class="text-sm font-medium">
				Exchange to {currency.code}
			</p>
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1">
					<Label for="fx-rate">Rate (1 {entryCode} = ? {currency.code})</Label>
					<Input
						id="fx-rate"
						inputmode="decimal"
						placeholder="0.000000"
						value={fxDriver === 'rate' ? rateInput : (effectiveRate ?? '')}
						oninput={(e) => onRateInput(e.currentTarget.value)}
					/>
				</div>
				<div class="space-y-1">
					<Label for="fx-total">Total in {currency.code}</Label>
					<div class="flex items-center gap-1">
						<span class="text-muted-foreground text-xs">{currency.symbol}</span>
						<Input
							id="fx-total"
							inputmode="decimal"
							placeholder="0.00"
							value={fxDriver === 'total'
								? settlementTotalInput
								: settlementPreview
									? formatAmount($formData.amountTotalSettlement, settlementCode, { symbol: false })
									: ''}
							oninput={(e) => onSettlementTotalInput(e.currentTarget.value)}
						/>
					</div>
				</div>
			</div>
			{#if settlementPreview}
				<p class="text-muted-foreground text-sm">
					{settlementPreview.txn} → {settlementPreview.settlement}
				</p>
			{/if}
			{#if $errors.exchangeRate}
				<p class="text-destructive text-sm">{$errors.exchangeRate}</p>
			{/if}
			{#if $errors.amountTotalSettlement}
				<p class="text-destructive text-sm">{$errors.amountTotalSettlement}</p>
			{/if}
		</div>
	{/if}

	<!-- Total amount. For non-itemized the user types it (major units → minor units).
	     For itemized the total is DERIVED from the items subtotal (§7.2.1), shown
	     read-only — the item rows below drive it. -->
	<div class="space-y-2">
		<Label for="amountTotal">Amount</Label>
		{#if $formData.splitMode === 'itemized'}
			<div class="flex items-center justify-between gap-2">
				<span class="text-muted-foreground text-sm">Total (items + charges)</span>
				<span class="font-medium">{formatAmount(itemizedTotal, currencyCode)}</span>
			</div>
		{:else}
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground text-sm">{entryCurrency.symbol}</span>
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
							<span class="text-muted-foreground text-xs">{entryCurrency.symbol}</span>
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
								<span class="text-muted-foreground text-xs">{entryCurrency.symbol}</span>
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
								<span class="text-muted-foreground text-xs">{entryCurrency.symbol}</span>
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
										<span class="text-muted-foreground text-xs">{entryCurrency.symbol}</span>
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
		</fieldset>

		<!-- Charges & discounts (PLAN §7.2.2, task 4.9): a repeatable list of charge
		     rows. Each charge has a kind (service/VAT/discount), a mode (percent /
		     fixed), a value (% → basis points, or a fixed amount → minor units), a base
		     (items subtotal / running total), applied in sort order. -->
		<fieldset class="space-y-4">
			<legend class="text-sm font-medium">Charges &amp; discounts</legend>
			{#each $formData.charges as charge, index (index)}
				<div class="space-y-3 rounded-md border p-3">
					<div class="flex items-end gap-2">
						<div class="flex-1 space-y-1">
							<Label>Type</Label>
							<Select.Root
								type="single"
								value={charge.kind}
								onValueChange={(v) => setChargeKind(index, v as ChargeInput['kind'])}
							>
								<Select.Trigger class="w-full">{chargeKindLabel(charge.kind)}</Select.Trigger>
								<Select.Content>
									{#each CHARGE_KINDS as k (k.value)}
										<Select.Item value={k.value} label={k.label}>{k.label}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onclick={() => removeCharge(index)}
							aria-label="Remove charge"
						>
							Remove
						</Button>
					</div>

					<div class="flex items-end gap-2">
						<div class="w-36 space-y-1">
							<Label>Mode</Label>
							<Select.Root
								type="single"
								value={charge.mode}
								onValueChange={(v) => setChargeMode(index, v as ChargeInput['mode'])}
							>
								<Select.Trigger class="w-full">{chargeModeLabel(charge.mode)}</Select.Trigger>
								<Select.Content>
									{#each CHARGE_MODES as m (m.value)}
										<Select.Item value={m.value} label={m.label}>{m.label}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
						<div class="w-28 space-y-1">
							<Label for="charge-{index}-value">Value</Label>
							<div class="flex items-center gap-1">
								<span class="text-muted-foreground text-xs">
									{charge.mode === 'percent' ? '%' : entryCurrency.symbol}
								</span>
								<Input
									id="charge-{index}-value"
									inputmode="decimal"
									placeholder={charge.mode === 'percent' ? '10' : '0.00'}
									value={chargeValueInputs[index] ?? ''}
									oninput={(e) => setChargeValue(index, e.currentTarget.value)}
								/>
							</div>
						</div>
					</div>

					<div class="space-y-1">
						<Label>Applies to</Label>
						<Select.Root
							type="single"
							value={charge.base}
							onValueChange={(v) => setChargeBase(index, v as ChargeInput['base'])}
						>
							<Select.Trigger class="w-full">{chargeBaseLabel(charge.base)}</Select.Trigger>
							<Select.Content>
								{#each CHARGE_BASES as b (b.value)}
									<Select.Item value={b.value} label={b.label}>{b.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>
			{/each}

			<Button type="button" variant="outline" size="sm" onclick={addCharge}>
				Add charge / discount
			</Button>

			{#if $errors.charges?._errors}
				<p class="text-destructive text-sm">{$errors.charges._errors}</p>
			{/if}
			{#if $errors.amountTotal}
				<p class="text-destructive text-sm">{$errors.amountTotal}</p>
			{/if}
		</fieldset>

		<!-- Live computed breakdown (§7.2.2 / §7.2.3 / §10): items subtotal → ± each
		     charge in sort order → total, PLUS each member's resolved final share. The
		     resolver is client-importable, so this previews who owes what before save. -->
		{#if itemizedBreakdown}
			<div class="space-y-3 rounded-md border p-3 text-sm">
				<div class="space-y-1">
					<p class="font-medium">Breakdown</p>
					<div class="flex items-center justify-between">
						<span class="text-muted-foreground">Items subtotal</span>
						<span>{formatAmount(itemsSubtotal, currencyCode)}</span>
					</div>
					{#each itemizedBreakdown.charges as resolved (resolved.charge.sortOrder)}
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">
								{chargeKindLabel(resolved.charge.kind)}
							</span>
							<span>
								{resolved.total < 0 ? '−' : '+'}{formatAmount(
									Math.abs(resolved.total),
									currencyCode
								)}
							</span>
						</div>
					{/each}
					<div class="flex items-center justify-between border-t pt-1 font-medium">
						<span>Total</span>
						<span class="text-right">
							<span class="block">{formatAmount(itemizedBreakdown.amountTotal, currencyCode)}</span>
							{#if isForeign && settlementPreview}
								<span class="text-muted-foreground block text-xs font-normal">
									{formatAmount($formData.amountTotalSettlement, settlementCode)}
								</span>
							{/if}
						</span>
					</div>
				</div>

				{#if itemizedBreakdown.shares.length > 0}
					<div class="space-y-1 border-t pt-2">
						<p class="font-medium">Each person owes</p>
						{#each itemizedBreakdown.shares as share (share.memberId)}
							<div class="flex items-center justify-between">
								<span>{memberName(share.memberId)}</span>
								<span class="text-right">
									<span class="block">{formatAmount(share.amountOwed, currencyCode)}</span>
									{#if isForeign && settlementShares}
										<span class="text-muted-foreground block text-xs">
											{formatAmount(settlementShares.get(share.memberId) ?? 0, settlementCode)}
										</span>
									{/if}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
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
	<!-- Charges (no-JS fallback). superForm `enhance` re-serializes from `$formData`
	     with JS; these carry the charge rows when JS is off (PLAN §7.2.2). -->
	{#each $formData.charges as charge, i (i)}
		<input type="hidden" name="charges[{i}].kind" value={charge.kind} />
		<input type="hidden" name="charges[{i}].mode" value={charge.mode} />
		<input type="hidden" name="charges[{i}].value" value={charge.value} />
		<input type="hidden" name="charges[{i}].base" value={charge.base} />
		<input type="hidden" name="charges[{i}].sortOrder" value={charge.sortOrder} />
	{/each}

	<Button type="submit" class="w-full" disabled={$submitting}>
		{$submitting ? 'Saving…' : submitLabel}
	</Button>
</form>
