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
	import { formatAmount, parseAmount, sanitizeAmountInput, type CurrencyCode } from '$lib/money';
	import { applyCharges, convertToSettlement } from '$lib/schemas/transaction';
	import { defaultCategoryFor } from '$lib/categories';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import CategoryIcon from '$lib/components/CategoryIcon.svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import MobileActionBar from '$lib/components/MobileActionBar.svelte';
	import {
		resolveShares,
		resolveItemizedWithCharges,
		distributeToSettlement
	} from '$lib/transactions/resolve';
	import { network } from '$lib/pwa/online.svelte';
	import { writeDisabled } from '$lib/pwa/offline-writes';

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

	// Disable the submit while offline (PLAN §11 — no offline creation) or while a
	// submit is in flight, with an accessible reason. The server still re-validates
	// regardless (server-first); this is the UX layer only.
	const write = $derived(writeDisabled(network.offline, $submitting));

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

	// Display formatters for the read-only previews below (the breakdown, the
	// derived itemized total). The ISO code is kept ONLY for a foreign entry
	// currency: within a group the settlement currency is already established by
	// context, so "JPY ¥6,800" on every preview line is redundant width. A
	// code-prefixed amount here therefore always signals "foreign".
	const entryDisplay = $derived((minor: number) =>
		formatAmount(minor, currencyCode, { code: isForeign })
	);
	const settlementDisplay = $derived((minor: number) =>
		formatAmount(minor, settlementCode, { code: false })
	);

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

	// ── How every money field on this form is wired ──────────────────────────────
	// Each one renders the RAW string the user typed (never `formatAmount` of the
	// parsed value — that re-formats under the caret, rewriting a typed "5" to
	// "5.00" mid-keystroke), and constrains that string with `sanitizeAmountInput`
	// on the way in. Without the constraint the two drift apart in the other
	// direction: `parseAmount` throws on "12a" / on a decimal place the currency
	// doesn't have, `toMinor` turns that into 0, and the field sits there showing
	// "12.345" for an amount recorded as nothing.
	//
	// They are `bind:value` ACCESSOR pairs rather than one-way `value=` for one
	// reason: a refused keystroke ("12" + "a" → "12") leaves the rendered string
	// unchanged, so a one-way binding repaints nothing and the character stays on
	// screen. Svelte's input binding re-reads the getter after the setter runs and,
	// when they disagree, rewrites the element and restores the caret — its
	// documented "respect any validation in accessors" path.

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
			return {
				txn: formatAmount(total, entryCode),
				settlement: formatAmount(stl, settlementCode, { code: false })
			};
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
		// The SETTLEMENT currency's precision, not the entry currency's — this box is
		// denominated in what the group settles in (§7.6).
		settlementTotalInput = sanitizeAmountInput(raw, settlementCode);
	}

	// What the settlement box shows: the typed string while the user is driving the
	// pair from this side, otherwise the total derived from the rate (read-only in
	// effect — typing here switches the driver).
	const settlementFieldValue = $derived(
		fxDriver === 'total'
			? settlementTotalInput
			: settlementPreview
				? formatAmount($formData.amountTotalSettlement, settlementCode, { symbol: false })
				: ''
	);

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

	/**
	 * Select every member as a beneficiary, or none. Backs the Everyone / None
	 * controls; each line is built by {@link beneficiaryFor} so it carries whatever
	 * per-member input the current split mode needs.
	 */
	function setAllBeneficiaries(all: boolean) {
		$formData.beneficiaries = all ? members.map((m) => beneficiaryFor(m.id)) : [];
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
		const cleaned = sanitizeAmountInput(raw, currencyCode);
		amountInputs[memberId] = cleaned;
		const minor = toMinor(cleaned) ?? 0;
		$formData.beneficiaries = $formData.beneficiaries.map((b) =>
			b.memberId === memberId ? { memberId, rawAmount: minor } : b
		);
	}

	// ── Payer selection ───────────────────────────────────────────────────────────
	const selectedPayerIds = $derived(new Set($formData.payers.map((p) => p.memberId)));

	// Per-payer amount display strings, keyed by member id — the same parallel-string
	// pattern as `amountInputs`. The input must NOT render `formatAmount(amountPaid)`:
	// that re-formats on every keystroke, so typing "5" was immediately rewritten to
	// "5.00" (cursor jumping past the decimals, "50" becoming "5.00" + "0").
	let paidInputs = $state<Record<string, string>>(
		Object.fromEntries(
			$formData.payers
				.filter((p) => p.amountPaid > 0)
				.map((p) => [p.memberId, formatAmount(p.amountPaid, currencyCode, { symbol: false })])
		)
	);

	/**
	 * Re-seed any display string that no longer parses back to its payer's amount.
	 * A string the user is mid-way through typing always round-trips (it's what
	 * produced `amountPaid`), so it is left untouched; a payer whose amount was set
	 * behind the input's back — the single-payer mirror in the effect above — is
	 * refreshed before the per-payer inputs become visible.
	 */
	function syncPaidInputs() {
		for (const p of $formData.payers) {
			if ((toMinor(paidInputs[p.memberId] ?? '') ?? 0) !== p.amountPaid) {
				paidInputs[p.memberId] =
					p.amountPaid > 0 ? formatAmount(p.amountPaid, currencyCode, { symbol: false }) : '';
			}
		}
	}

	function togglePayer(memberId: string, checked: boolean) {
		if (checked) {
			if (!selectedPayerIds.has(memberId)) {
				// New payer: 0 paid by default. A single payer is kept in sync with the
				// total by the effect above; with multiple payers the user enters each.
				$formData.payers = [...$formData.payers, { memberId, amountPaid: 0 }];
				paidInputs[memberId] = '';
				syncPaidInputs();
			}
		} else {
			$formData.payers = $formData.payers.filter((p) => p.memberId !== memberId);
			delete paidInputs[memberId];
		}
	}

	/** A keystroke in a payer's amount box (see the money-field note above). */
	function setPaid(memberId: string, raw: string) {
		const cleaned = sanitizeAmountInput(raw, currencyCode);
		paidInputs[memberId] = cleaned;
		const minor = toMinor(cleaned) ?? 0;
		$formData.payers = $formData.payers.map((p) =>
			p.memberId === memberId ? { memberId, amountPaid: minor } : p
		);
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
		const mode = $formData.charges[index].mode;
		// Only the ABSOLUTE mode is a money amount in the entry currency. A PERCENT is
		// a different grammar (0–100 → basis points, its own precision rule), so it is
		// left as typed here rather than run through a money sanitizer that would
		// mangle it; constraining that entry is a separate change.
		const cleaned = mode === 'absolute' ? sanitizeAmountInput(raw, currencyCode) : raw;
		chargeValueInputs[index] = cleaned;
		patchCharge(index, { value: parseChargeValue(mode, cleaned) });
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
		const cleaned = sanitizeAmountInput(raw, currencyCode);
		itemAmountInputs[index] = cleaned;
		patchItem(index, { amount: toMinor(cleaned) ?? 0 });
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
		const cleaned = sanitizeAmountInput(raw, currencyCode);
		itemMemberAmountInputs[`${index}:${memberId}`] = cleaned;
		const minor = toMinor(cleaned) ?? 0;
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

	// ── Live "who owes what", for EVERY split mode ───────────────────────────────
	// The itemized breakdown above has always previewed this, but equal / amount /
	// share — the modes almost everyone actually uses — showed nothing, so you could
	// not see that ¥6,800 split four ways is ¥1,700 each until AFTER saving. Same
	// client-importable resolver the service persists with: a rendering change, not
	// a second implementation of the maths.
	//
	// Best-effort by design: null whenever the form isn't in a resolvable state yet
	// (nothing typed, no beneficiaries, an `amount` split that doesn't add up), so a
	// half-filled form shows no preview rather than a wrong one.
	const previewShares = $derived.by(() => {
		if ($formData.splitMode === 'itemized') return itemizedBreakdown?.shares ?? null;

		const total = toMinor(totalInput) ?? 0;
		if (total <= 0 || $formData.beneficiaries.length === 0) return null;
		try {
			return resolveShares({
				splitMode: $formData.splitMode,
				amountTotal: total,
				beneficiaries: $formData.beneficiaries
			});
		} catch {
			return null;
		}
	});

	/**
	 * The one-line summary for an EQUAL split ("¥1,700 each") — but only when every
	 * member genuinely owes the same. An equal split that doesn't divide cleanly
	 * leaves the remainder on some members, and a single figure would then be a lie,
	 * so those fall through to the per-member list instead.
	 */
	const equalEach = $derived.by(() => {
		if ($formData.splitMode !== 'equal' || !previewShares || previewShares.length === 0) {
			return null;
		}
		const first = previewShares[0].amountOwed;
		return previewShares.every((s) => s.amountOwed === first) ? first : null;
	});

	// Per-member SETTLEMENT-converted owed for the itemized breakdown (§7.6): convert
	// the txn total once, then distribute across members by their txn-currency owed —
	// the SAME convert-then-distribute the service persists. Null when not foreign or
	// the breakdown/rate isn't ready.
	const settlementShares = $derived.by(() => {
		if (!isForeign || !previewShares || previewShares.length === 0) return null;
		const stl = $formData.amountTotalSettlement;
		if (stl <= 0) return null;
		try {
			return new Map(
				distributeToSettlement(
					previewShares.map((s) => ({ memberId: s.memberId, amount: s.amountOwed })),
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
				// Reset to the new type's DEFAULT category (§7.3) — the neutral "Other"
				// for spending, not the first of the list (Food & Drink), which silently
				// filed every rent payment and taxi as food. See `defaultCategoryFor`.
				$formData.categoryId = defaultCategoryFor(v as 'spending' | 'transfer');
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
			placeholder={$formData.type === 'transfer' ? 'Debt settlement' : 'Dinner'}
			aria-invalid={$errors.title ? 'true' : undefined}
			aria-describedby={$errors.title ? 'title-error' : undefined}
			bind:value={$formData.title}
		/>
		{#if $errors.title}<p id="title-error" class="text-destructive text-sm">{$errors.title}</p>{/if}
	</div>

	<!-- AMOUNT — the most consequential input on the form, so it now looks it. It sat
	     below four metadata fields at exactly the same visual weight as Title, with
	     the currency symbol floating OUTSIDE the box as loose grey text (which read
	     as a rendering glitch). The symbol is now an affix inside the field.

	     For non-itemized the user types it (major units → minor units). For itemized
	     the total is DERIVED from the items subtotal (§7.2.1) and shown read-only —
	     the item rows below drive it. -->
	<div class="space-y-2">
		<Label for="amountTotal" class="text-muted-foreground">Amount</Label>
		{#if $formData.splitMode === 'itemized'}
			<div class="flex items-baseline justify-between gap-2">
				<span class="text-3xl font-semibold tabular-nums">{entryDisplay(itemizedTotal)}</span>
				<span class="text-muted-foreground text-sm">from items + charges</span>
			</div>
		{:else}
			<div
				class="border-input focus-within:border-ring focus-within:ring-ring/50 flex items-center rounded-md border px-3 focus-within:ring-[3px]"
			>
				<span class="text-muted-foreground shrink-0 text-2xl" aria-hidden="true">
					{entryCurrency.symbol}
				</span>
				<Input
					id="amountTotal"
					inputmode="decimal"
					placeholder="0.00"
					aria-invalid={$errors.amountTotal ? 'true' : undefined}
					aria-describedby={$errors.amountTotal ? 'amountTotal-error' : undefined}
					bind:value={() => totalInput, (v) => (totalInput = sanitizeAmountInput(v, currencyCode))}
					class="h-14 flex-1 border-0 bg-transparent px-1 text-2xl font-semibold tabular-nums shadow-none focus-visible:ring-0"
				/>
			</div>
		{/if}
		{#if $errors.amountTotal}<p id="amountTotal-error" class="text-destructive text-sm">
				{$errors.amountTotal}
			</p>{/if}
	</div>

	<!-- Secondary detail. Date and category are all but always left at their
	     defaults, so they share a row and are quieted rather than each taking a
	     full-width row at the same weight as Title and Amount. -->
	<div class="grid gap-3 sm:grid-cols-2">
		<!-- Date (PLAN §7.1) — the editable real-world date; may be backdated (e.g. an
	     entry recorded the day after it happened). Native date input, no-JS friendly. -->
		<div class="space-y-2">
			<Label for="date">Date</Label>
			<Input
				id="date"
				name="date"
				type="date"
				aria-invalid={$errors.date ? 'true' : undefined}
				aria-describedby={$errors.date ? 'date-error' : undefined}
				bind:value={$formData.date}
			/>
			{#if $errors.date}<p id="date-error" class="text-destructive text-sm">{$errors.date}</p>{/if}
		</div>

		<!-- Category picker (PLAN §7.3) — shadcn Select filtered by type. The hidden
	     input above carries the value for no-JS; the Select drives it with JS. -->
		<div class="space-y-2">
			<Label>Category</Label>
			<Select.Root type="single" bind:value={$formData.categoryId}>
				<Select.Trigger class="w-full" aria-label="Category">
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
	</div>

	<!-- Currency picker (PLAN §7.6): defaults to the group settlement currency.
	     Choosing a DIFFERENT currency reveals the FX (rate / settlement-total) entry.

	     Behind a disclosure: a group is single-currency in the overwhelming majority
	     of cases, so this occupied a full-width row on every visit to serve the rare
	     one. It opens ALREADY EXPANDED whenever a foreign currency is in play
	     (editing such a transaction, or arriving via a §8.4 prefill), so the FX entry
	     below is never hidden behind a click. With only one supported currency there
	     is nothing to choose and the control is omitted entirely.
	     `<details>` keeps it usable with JS disabled. -->
	{#if currencyOptions.length > 1}
		<details class="group/currency" open={isForeign}>
			<summary
				class="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-sm focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
			>
				<ChevronDownIcon
					class="size-4 transition-transform group-open/currency:rotate-180"
					aria-hidden="true"
				/>
				Paid in {entryCode}{isForeign ? '' : ' — the group currency'}
			</summary>
			<div class="space-y-2 pt-2">
				<Label>Currency</Label>
				<Select.Root type="single" value={entryCode} onValueChange={onCurrencyChange}>
					<Select.Trigger class="w-full" aria-label="Currency">
						{selectedCurrencyLabel}
					</Select.Trigger>
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
		</details>
	{/if}

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
						aria-invalid={$errors.exchangeRate ? 'true' : undefined}
						aria-describedby={$errors.exchangeRate ? 'fx-error' : undefined}
						value={fxDriver === 'rate' ? rateInput : (effectiveRate ?? '')}
						oninput={(e) => onRateInput(e.currentTarget.value)}
					/>
				</div>
				<div class="space-y-1">
					<Label for="fx-total">Total in {currency.code}</Label>
					<div class="flex items-center gap-1">
						<span class="text-muted-foreground text-xs" aria-hidden="true">{currency.symbol}</span>
						<Input
							id="fx-total"
							inputmode="decimal"
							placeholder="0.00"
							aria-invalid={$errors.amountTotalSettlement ? 'true' : undefined}
							aria-describedby={$errors.amountTotalSettlement ? 'fx-error' : undefined}
							bind:value={() => settlementFieldValue, (v) => onSettlementTotalInput(v)}
						/>
					</div>
				</div>
			</div>
			{#if settlementPreview}
				<p class="text-muted-foreground text-sm">
					{settlementPreview.txn} → {settlementPreview.settlement}
				</p>
			{/if}
			{#if $errors.exchangeRate || $errors.amountTotalSettlement}
				<div id="fx-error" class="text-destructive space-y-1 text-sm">
					{#if $errors.exchangeRate}<p>{$errors.exchangeRate}</p>{/if}
					{#if $errors.amountTotalSettlement}<p>{$errors.amountTotalSettlement}</p>{/if}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Paid by. Default = the acting user's member, paying the whole total. With
	     >1 payer, per-payer amounts appear below (Σ == total).

	     Wrapping CHIPS, not a full-width column. "Paid by" and "Split between" are
	     the same roster rendered twice, and as two identical stacked columns a
	     four-person group cost eight rows of names for what is almost always "I
	     paid, split evenly". These are still real checkboxes with the member name as
	     their accessible name — only the layout changed. -->
	<fieldset class="space-y-2">
		<legend class="text-sm font-medium">Paid by</legend>
		<div class="flex flex-wrap gap-2">
			{#each members as member (member.id)}
				{@const isPayer = selectedPayerIds.has(member.id)}
				<label
					class="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors {isPayer
						? 'border-primary bg-primary/10'
						: 'hover:bg-accent'}"
				>
					<Checkbox checked={isPayer} onCheckedChange={(v) => togglePayer(member.id, !!v)} />
					{member.displayName}
				</label>
			{/each}
		</div>
		{#if multiplePayers}
			<!-- Per-payer amounts, for the selected payers only and only once there is
			     more than one — a single payer covers the whole total by definition. -->
			<div class="space-y-1 pt-1">
				{#each members.filter((m) => selectedPayerIds.has(m.id)) as member (member.id)}
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm">{member.displayName}</span>
						<div class="flex items-center gap-1">
							<span class="text-muted-foreground text-xs" aria-hidden="true">
								{entryCurrency.symbol}
							</span>
							<Input
								inputmode="decimal"
								placeholder="0.00"
								aria-label="Amount paid by {member.displayName}"
								bind:value={() => paidInputs[member.id] ?? '',
								(v) => setPaid(member.id, v)}
								class="h-10 w-24"
							/>
						</div>
					</div>
				{/each}
			</div>
		{/if}
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
			<!-- "Everyone" is the overwhelmingly common case, and un-picking then
			     re-picking a long roster one checkbox at a time was the only way back
			     to it. -->
			<div class="flex items-center gap-1">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-8 px-2 text-xs"
					onclick={() => setAllBeneficiaries(true)}
					disabled={selectedBeneficiaryIds.size === members.length}
				>
					Everyone
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-8 px-2 text-xs"
					onclick={() => setAllBeneficiaries(false)}
					disabled={selectedBeneficiaryIds.size === 0}
				>
					None
				</Button>
			</div>
			{#if $formData.splitMode === 'equal'}
				<!-- `equal` takes no per-member input, so it gets the same compact chips
				     as "Paid by" instead of a second full-width column of the roster.
				     The modes that DO take an input per person keep the column below,
				     which is what those inputs need. -->
				<div class="flex flex-wrap gap-2">
					{#each members as member (member.id)}
						{@const isBeneficiary = selectedBeneficiaryIds.has(member.id)}
						<label
							class="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors {isBeneficiary
								? 'border-primary bg-primary/10'
								: 'hover:bg-accent'}"
						>
							<Checkbox
								checked={isBeneficiary}
								onCheckedChange={(v) => toggleBeneficiary(member.id, !!v)}
							/>
							{member.displayName}
						</label>
					{/each}
				</div>
			{:else}
				<div>
					{#each members as member (member.id)}
						{@const isBeneficiary = selectedBeneficiaryIds.has(member.id)}
						<div class="flex min-h-11 items-center justify-between gap-2">
							<label class="flex flex-1 items-center gap-3 text-sm">
								<Checkbox
									checked={isBeneficiary}
									onCheckedChange={(v) => toggleBeneficiary(member.id, !!v)}
								/>
								{member.displayName}
							</label>
							{#if isBeneficiary && $formData.splitMode === 'amount'}
								<div class="flex items-center gap-1">
									<span class="text-muted-foreground text-xs" aria-hidden="true"
										>{entryCurrency.symbol}</span
									>
									<Input
										inputmode="decimal"
										placeholder="0.00"
										aria-label="Amount for {member.displayName}"
										bind:value={() => amountInputs[member.id] ?? '',
										(v) => setRawAmount(member.id, v)}
										class="h-10 w-24"
									/>
								</div>
							{:else if isBeneficiary && $formData.splitMode === 'share'}
								<Input
									inputmode="numeric"
									placeholder="1"
									aria-label="Shares for {member.displayName}"
									value={$formData.beneficiaries.find((b) => b.memberId === member.id)
										?.shareWeight ?? 1}
									oninput={(e) => setShareWeight(member.id, e.currentTarget.value)}
									class="h-10 w-20"
								/>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
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
								aria-label="Item {index + 1} name"
								value={item.label}
								oninput={(e) => setItemLabel(index, e.currentTarget.value)}
							/>
						</div>
						<div class="w-28 space-y-1">
							<Label for="item-{index}-amount">Amount</Label>
							<div class="flex items-center gap-1">
								<span class="text-muted-foreground text-xs" aria-hidden="true">
									{entryCurrency.symbol}
								</span>
								<Input
									id="item-{index}-amount"
									inputmode="decimal"
									placeholder="0.00"
									aria-label="Item {index + 1} amount"
									bind:value={() => itemAmountInputs[index] ?? '',
									(v) => setItemAmount(index, v)}
								/>
							</div>
						</div>
						<!-- An icon, not the word "Remove": as a text button it was as wide as
						     the amount field beside it, squeezing the item name down to ~90px
						     so its placeholder clipped to "e.g. Piz:". -->
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="size-11 shrink-0"
							onclick={() => removeItem(index)}
							disabled={$formData.items.length <= 1}
							aria-label="Remove item {index + 1}"
						>
							<Trash2Icon class="size-4" aria-hidden="true" />
						</Button>
					</div>

					<!-- The per-item split is COLLAPSED by default. Every item repeated the
					     full member checkbox list AND a three-tab mode switcher, so two
					     items on a four-person trip ran past 2,000px on a phone — while most
					     items just take the obvious "everyone, evenly". The summary states
					     the current split, so collapsing hides nothing you need to verify.
					     `<details>` keeps it reachable with JS disabled. -->
					<details class="group/item">
						<summary
							class="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-xs focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
						>
							<ChevronDownIcon
								class="size-4 transition-transform group-open/item:rotate-180"
								aria-hidden="true"
							/>
							<span class="sr-only">Item {index + 1} split —</span>
							Split {item.beneficiaries.length}
							{item.beneficiaries.length === 1 ? 'way' : 'ways'} · {item.splitMode}
						</summary>
						<div class="space-y-3 pt-2">
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
							<div>
								{#each members as member (member.id)}
									{@const isBeneficiary = itemHasBeneficiary(index, member.id)}
									<div class="flex min-h-11 items-center justify-between gap-2">
										<label class="flex flex-1 items-center gap-3 text-sm">
											<Checkbox
												checked={isBeneficiary}
												onCheckedChange={(v) => toggleItemBeneficiary(index, member.id, !!v)}
											/>
											{member.displayName}
										</label>
										{#if isBeneficiary && item.splitMode === 'amount'}
											<div class="flex items-center gap-1">
												<span class="text-muted-foreground text-xs" aria-hidden="true"
													>{entryCurrency.symbol}</span
												>
												<Input
													inputmode="decimal"
													placeholder="0.00"
													aria-label="Item {index + 1} amount for {member.displayName}"
													bind:value={() =>
														itemMemberAmountInputs[`${index}:${member.id}`] ?? '',
													(v) => setItemRawAmount(index, member.id, v)}
													class="h-10 w-24"
												/>
											</div>
										{:else if isBeneficiary && item.splitMode === 'share'}
											<Input
												inputmode="numeric"
												placeholder="1"
												aria-label="Item {index + 1} shares for {member.displayName}"
												value={itemShareWeightValue(index, member.id)}
												oninput={(e) => setItemShareWeight(index, member.id, e.currentTarget.value)}
												class="h-10 w-20"
											/>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					</details>
				</div>
			{/each}

			<Button type="button" variant="outline" size="sm" class="min-h-11" onclick={addItem}
				>Add item</Button
			>

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
								<Select.Trigger class="w-full" aria-label="Charge {index + 1} type">
									{chargeKindLabel(charge.kind)}
								</Select.Trigger>
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
							aria-label="Remove charge {index + 1}"
							class="min-h-11"
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
								<Select.Trigger class="w-full" aria-label="Charge {index + 1} mode">
									{chargeModeLabel(charge.mode)}
								</Select.Trigger>
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
								<span class="text-muted-foreground text-xs" aria-hidden="true">
									{charge.mode === 'percent' ? '%' : entryCurrency.symbol}
								</span>
								<Input
									id="charge-{index}-value"
									inputmode="decimal"
									placeholder={charge.mode === 'percent' ? '10' : '0.00'}
									aria-label="Charge {index + 1} value"
									bind:value={() => chargeValueInputs[index] ?? '',
									(v) => setChargeValue(index, v)}
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
							<Select.Trigger class="w-full" aria-label="Charge {index + 1} applies to">
								{chargeBaseLabel(charge.base)}
							</Select.Trigger>
							<Select.Content>
								{#each CHARGE_BASES as b (b.value)}
									<Select.Item value={b.value} label={b.label}>{b.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>
			{/each}

			<Button type="button" variant="outline" size="sm" class="min-h-11" onclick={addCharge}>
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
						<span>{entryDisplay(itemsSubtotal)}</span>
					</div>
					{#each itemizedBreakdown.charges as resolved (resolved.charge.sortOrder)}
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">
								{chargeKindLabel(resolved.charge.kind)}
							</span>
							<span>
								{resolved.total < 0 ? '−' : '+'}{entryDisplay(Math.abs(resolved.total))}
							</span>
						</div>
					{/each}
					<div class="flex items-center justify-between border-t pt-1 font-medium">
						<span>Total</span>
						<span class="text-right">
							<span class="block">{entryDisplay(itemizedBreakdown.amountTotal)}</span>
							{#if isForeign && settlementPreview}
								<span class="text-muted-foreground block text-xs font-normal">
									{settlementDisplay($formData.amountTotalSettlement)}
								</span>
							{/if}
						</span>
					</div>
				</div>
			</div>
		{/if}
	{/if}

	<!-- Live preview of the resolved split.

	     This "each person owes" panel used to live INSIDE the itemized branch, so the
	     modes almost everyone uses — equal, amount, share — committed blind: you
	     could not see that ¥6,800 four ways is ¥1,700 each until after saving. It now
	     renders for every mode. A cleanly-dividing equal split collapses to one line;
	     everything else lists per member. -->
	{#if previewShares && previewShares.length > 0}
		{#if equalEach !== null}
			<div class="bg-muted/40 flex items-center justify-between rounded-md border p-3 text-sm">
				<span class="text-muted-foreground">Each person owes</span>
				<span class="text-right">
					<span class="block font-medium tabular-nums">{entryDisplay(equalEach)}</span>
					{#if isForeign && settlementShares}
						<span class="text-muted-foreground block text-xs tabular-nums">
							{settlementDisplay(settlementShares.get(previewShares[0].memberId) ?? 0)}
						</span>
					{/if}
				</span>
			</div>
		{:else}
			<div class="bg-muted/40 space-y-1 rounded-md border p-3 text-sm">
				<p class="font-medium">Each person owes</p>
				{#each previewShares as share (share.memberId)}
					<div class="flex items-center justify-between">
						<span>{memberName(share.memberId)}</span>
						<span class="text-right">
							<span class="block tabular-nums">{entryDisplay(share.amountOwed)}</span>
							{#if isForeign && settlementShares}
								<span class="text-muted-foreground block text-xs tabular-nums">
									{settlementDisplay(settlementShares.get(share.memberId) ?? 0)}
								</span>
							{/if}
						</span>
					</div>
				{/each}
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

	<!-- Bottom-reachable primary action (PLAN #28, §10): this is the longest,
	     most interaction-heavy screen, so the submit is anchored to the bottom of
	     the viewport on phones (thumb-reachable, safe-area aware) and reverts to a
	     normal inline block from `sm:` up. The REAL submit stays inside the real
	     <form>, so progressive enhancement is unchanged. -->
	<MobileActionBar>
		<Button
			type="submit"
			class="h-11 w-full"
			disabled={write.disabled}
			title={write.reason ?? undefined}
			aria-describedby={write.reason ? 'offline-write-note' : undefined}
		>
			{$submitting ? 'Saving…' : submitLabel}
		</Button>
		{#if network.offline}
			<p id="offline-write-note" class="text-muted-foreground mt-2 text-sm" role="note">
				{write.reason}
			</p>
		{/if}
	</MobileActionBar>
</form>
