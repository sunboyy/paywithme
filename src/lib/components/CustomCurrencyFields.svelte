<script lang="ts">
	// The four fields of a CUSTOM currency, plus the live preview and the
	// permanence labelling (issue #62; PLAN §7.5.2, §10; ADR-0014).
	//
	// ONE component for both the "add" form and every row's "edit" form, so the two
	// can never disagree about what is permanent, what a value will look like, or
	// what a frozen field says. It renders plain named inputs inside whatever
	// `<form>` the caller provides — the page is server-first, so the fields post
	// themselves and work with JS disabled; the preview is the only part that needs
	// JS, and its absence costs nothing.
	//
	// ── The preview goes through `formatAmount` ──────────────────────────────────
	// Deliberately NOT a hand-rolled `${symbol}${amount}` string. What the user sees
	// while typing has to be what the ledger will render, which includes the rule
	// they cannot guess: a custom currency ALWAYS shows its display code in front of
	// its symbol, because a member-authored symbol can be assumed neither unique nor
	// free of `$` (PLAN §7.5.2 "Display and formatting"; ADR-0014 decision 4). Typing
	// `$` here previews `MYUSD $1,234.56`, not `$1,234.56` — surprising exactly once,
	// on this screen, instead of after ten recorded transactions.
	//
	// `formatAmount` takes a resolved descriptor (#60), and reads "is this custom?"
	// off `code !== displayCode`. The row being previewed may not exist yet, so we
	// pass a placeholder opaque code: uppercase display codes can never equal the
	// lowercase `cur_…` shape, so the descriptor is always classified as custom —
	// matching what the real row will be.
	//
	// shadcn-svelte primitives come from `$lib/components/ui/**` (CLI-generated;
	// never hand-authored here).
	import { formatAmount } from '$lib/money';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import LockIcon from '@lucide/svelte/icons/lock';

	let {
		idPrefix,
		displayCode = $bindable(''),
		currencyName = $bindable(''),
		symbol = $bindable(''),
		exponent = $bindable(2),
		locked = false,
		errors = {}
	}: {
		/** Unique per rendered instance — every field id/`for` is derived from it. */
		idPrefix: string;
		/** The user-visible code (CONTEXT.md "Display code"), e.g. `BEER`. */
		displayCode?: string;
		/** The currency's human-readable name. Named to avoid clashing with `name`. */
		currencyName?: string;
		/** The display symbol, e.g. `🍺`. Member-authored. */
		symbol?: string;
		/** Minor-unit exponent 0–3 (PLAN §7.5). */
		exponent?: number;
		/**
		 * Is a transaction already recorded in this currency? Then `displayCode` and
		 * `exponent` are FROZEN (ADR-0014 decision 5) and render read-only with a
		 * reason — rather than letting the user type a change the server will refuse.
		 */
		locked?: boolean;
		/** Per-field messages from the last submit, keyed by field name. */
		errors?: Partial<Record<'displayCode' | 'name' | 'symbol' | 'exponent', string[] | undefined>>;
	} = $props();

	/**
	 * Sample amount for the preview, as INTEGER MINOR UNITS at the chosen exponent
	 * (no floats — CLAUDE.md). `1234.56` at 2 decimals, the same magnitude at any
	 * other: `1234` / `1,234.5` / `1,234.560`, so the decimal-places choice is
	 * visible in the preview itself.
	 */
	function sampleMinor(exp: number): number {
		return Number(`1234${'56'.padEnd(exp, '0').slice(0, exp)}`);
	}

	/** Clamp to the schema's 0–3 range so a half-typed value can't throw the preview. */
	const previewExponent = $derived(
		Number.isFinite(exponent) ? Math.min(3, Math.max(0, Math.trunc(exponent))) : 2
	);

	// Mirror the schema's `trim().toUpperCase()` so the preview shows the code as it
	// will be STORED, not as it was typed.
	const previewCode = $derived(displayCode.trim().toUpperCase() || 'CODE');
	const previewSymbol = $derived(symbol.trim() || '¤');

	const preview = $derived(
		formatAmount(sampleMinor(previewExponent), {
			// Placeholder opaque id — never displayed, only used to classify the
			// descriptor as custom (see the header).
			code: 'cur_preview',
			displayCode: previewCode,
			exponent: previewExponent,
			symbol: previewSymbol
		})
	);

	const DECIMAL_OPTIONS = [
		{ value: 0, label: '0 — whole units (3 BEER)' },
		{ value: 1, label: '1 decimal place' },
		{ value: 2, label: '2 — money-like (12.50)' },
		{ value: 3, label: '3 decimal places' }
	];

	/** `aria-describedby` for a field: its hint, plus its error when there is one. */
	function describedBy(field: keyof typeof errors): string {
		const ids = [`${idPrefix}-${field}-hint`];
		if (errors[field]?.length) {
			ids.push(`${idPrefix}-${field}-error`);
		}
		return ids.join(' ');
	}
</script>

<div class="space-y-4">
	<div class="grid gap-4 sm:grid-cols-2">
		<!-- Display code. Permanent once used, so say so BEFORE it is used, and
		     render it read-only afterwards with the reason. -->
		<div class="space-y-1.5">
			<Label for="{idPrefix}-displayCode">Code</Label>
			<Input
				id="{idPrefix}-displayCode"
				name="displayCode"
				type="text"
				bind:value={displayCode}
				readonly={locked}
				maxlength={8}
				placeholder="BEER"
				autocapitalize="characters"
				aria-invalid={errors.displayCode?.length ? 'true' : undefined}
				aria-describedby={describedBy('displayCode')}
				class={locked ? 'bg-muted text-muted-foreground' : ''}
			/>
			<p id="{idPrefix}-displayCode-hint" class="text-xs text-muted-foreground">
				{#if locked}
					<LockIcon class="mr-1 inline size-3" aria-hidden="true" />
					Can't be changed — a transaction is already recorded in this currency.
				{:else}
					Short, like <code>BEER</code>. Permanent once a transaction uses it.
				{/if}
			</p>
			{#if errors.displayCode?.length}
				<p id="{idPrefix}-displayCode-error" class="text-sm text-destructive">
					{errors.displayCode.join('. ')}
				</p>
			{/if}
		</div>

		<!-- Name: always editable. -->
		<div class="space-y-1.5">
			<Label for="{idPrefix}-name">Name</Label>
			<Input
				id="{idPrefix}-name"
				name="name"
				type="text"
				bind:value={currencyName}
				maxlength={60}
				placeholder="Bottle of beer"
				aria-invalid={errors.name?.length ? 'true' : undefined}
				aria-describedby={describedBy('name')}
			/>
			<p id="{idPrefix}-name-hint" class="text-xs text-muted-foreground">
				What this unit is. You can change this later.
			</p>
			{#if errors.name?.length}
				<p id="{idPrefix}-name-error" class="text-sm text-destructive">{errors.name.join('. ')}</p>
			{/if}
		</div>

		<!-- Symbol: always editable. -->
		<div class="space-y-1.5">
			<Label for="{idPrefix}-symbol">Symbol</Label>
			<Input
				id="{idPrefix}-symbol"
				name="symbol"
				type="text"
				bind:value={symbol}
				maxlength={8}
				placeholder="🍺"
				aria-invalid={errors.symbol?.length ? 'true' : undefined}
				aria-describedby={describedBy('symbol')}
			/>
			<p id="{idPrefix}-symbol-hint" class="text-xs text-muted-foreground">
				Shown in front of an amount. You can change this later.
			</p>
			{#if errors.symbol?.length}
				<p id="{idPrefix}-symbol-error" class="text-sm text-destructive">
					{errors.symbol.join('. ')}
				</p>
			{/if}
		</div>

		<!-- Decimal places: THE field the immutability lock exists for. -->
		<div class="space-y-1.5">
			<Label for="{idPrefix}-exponent">Decimal places</Label>
			{#if locked}
				<!-- Read-only rather than a save that fails: the value still POSTS (via
				     the hidden input), so the service sees it unchanged and the rest of
				     the row stays editable. -->
				<input type="hidden" name="exponent" value={exponent} />
				<p
					id="{idPrefix}-exponent"
					class="flex h-9 items-center rounded-md border border-input bg-muted px-3 py-1 text-sm text-muted-foreground"
					data-testid="{idPrefix}-exponent-readonly"
				>
					{exponent}
				</p>
			{:else}
				<!-- A native <select>: four fixed options, server-first, no JS needed. -->
				<select
					id="{idPrefix}-exponent"
					name="exponent"
					bind:value={exponent}
					aria-invalid={errors.exponent?.length ? 'true' : undefined}
					aria-describedby={describedBy('exponent')}
					class="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					{#each DECIMAL_OPTIONS as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			{/if}
			<p id="{idPrefix}-exponent-hint" class="text-xs text-muted-foreground">
				{#if locked}
					<LockIcon class="mr-1 inline size-3" aria-hidden="true" />
					Can't be changed — a transaction is already recorded in this currency.
				{:else}
					How many decimals an amount has. <strong>Permanent</strong> once a transaction uses this currency
					— changing it later would reinterpret every amount already recorded.
				{/if}
			</p>
			{#if errors.exponent?.length}
				<p id="{idPrefix}-exponent-error" class="text-sm text-destructive">
					{errors.exponent.join('. ')}
				</p>
			{/if}
		</div>
	</div>

	<!-- Live preview, straight through `formatAmount` (see the header). -->
	<p class="text-sm text-muted-foreground" data-testid="{idPrefix}-preview">
		Amounts will look like
		<span class="font-medium text-foreground" data-testid="{idPrefix}-preview-value">{preview}</span
		>
	</p>
</div>
