<script lang="ts">
	// The fields of ONE receiving method, rendered from the rail's own descriptors
	// (issue #85; PLAN §17.2, §17.4; ADR-0016).
	//
	// ONE component for both the add form and the edit form — and, more importantly,
	// one component for EVERY RAIL. It branches on a field's CONTROL (text / select /
	// textarea) and never on which rail it belongs to: a rail added later ships its
	// own descriptors and renders here untouched.
	//
	// It renders plain named inputs inside whatever `<form>` the caller provides, so
	// the page stays server-first and the whole form posts with JS disabled. The
	// `<select>` is NATIVE for the same reason the api-key screen uses native radios:
	// the shadcn Select renders JS-driven buttons, which would submit nothing without
	// JS — and the bank is not a field the no-JS user may lose.
	//
	// NO VALIDATION RULES ARE RESTATED HERE. Messages arrive in `errors`, straight
	// from the rail's Zod schema by way of the server action; the only constraint
	// this component applies is the schema's own `maxLength`, passed through by the
	// descriptor.
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { RailField } from '$lib/payout-rail-fields';

	let {
		idPrefix,
		fields,
		values,
		errors = {}
	}: {
		/** Unique per rendered instance — every field id / `for` / error id derives from it. */
		idPrefix: string;
		/** The rail's descriptors, in form order. */
		fields: readonly RailField[];
		/** Current value per field name. Missing keys render empty. */
		values: Record<string, string>;
		/** Per-field messages from the last submit, keyed by field name. */
		errors?: Record<string, string[] | undefined>;
	} = $props();

	const fieldId = (name: string) => `${idPrefix}-${name}`;
	const hintId = (name: string) => `${idPrefix}-${name}-hint`;
	const errorId = (name: string) => `${idPrefix}-${name}-error`;

	/**
	 * What a `select` should show. Svelte clears the selection (`selectedIndex =
	 * -1`) when the bound value matches no option, so a blank add form would render
	 * an EMPTY select that posts nothing — while the same markup server-rendered
	 * leaves the browser on the first option. Falling back to the first option keeps
	 * the hydrated form and the no-JS form saying the same thing.
	 */
	function selectValue(field: RailField): string {
		const options = field.options ?? [];
		const current = values[field.name] ?? '';
		return options.some((option) => option.value === current) ? current : (options[0]?.value ?? '');
	}

	/** Point the input at whichever of its hint / error is actually rendered. */
	function describedBy(field: RailField): string | undefined {
		const ids = [
			field.hint ? hintId(field.name) : null,
			errors[field.name]?.length ? errorId(field.name) : null
		].filter(Boolean);
		return ids.length ? ids.join(' ') : undefined;
	}
</script>

{#each fields as field (field.name)}
	{@const invalid = Boolean(errors[field.name]?.length)}
	<div class="space-y-1.5">
		<Label for={fieldId(field.name)}>{field.label}</Label>

		{#if field.control === 'select'}
			<!-- Native, so it submits without JS (see the header). No blank option: the
			     first choice is pre-selected, and "no rail is privileged" is about the
			     rail picker, not about which bank happens to be listed first. -->
			<select
				id={fieldId(field.name)}
				name={field.name}
				value={selectValue(field)}
				aria-invalid={invalid ? 'true' : undefined}
				aria-describedby={describedBy(field)}
				class="h-11 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-9 md:text-sm"
			>
				{#each field.options ?? [] as option (option.value)}
					<option value={option.value}>{option.label}</option>
				{/each}
			</select>
		{:else if field.control === 'textarea'}
			<Textarea
				id={fieldId(field.name)}
				name={field.name}
				value={values[field.name] ?? ''}
				maxlength={field.maxLength}
				placeholder={field.placeholder}
				aria-invalid={invalid ? 'true' : undefined}
				aria-describedby={describedBy(field)}
			/>
		{:else}
			<Input
				id={fieldId(field.name)}
				name={field.name}
				type="text"
				inputmode={field.inputMode}
				value={values[field.name] ?? ''}
				maxlength={field.maxLength}
				placeholder={field.placeholder}
				aria-invalid={invalid ? 'true' : undefined}
				aria-describedby={describedBy(field)}
			/>
		{/if}

		{#if field.hint}
			<p id={hintId(field.name)} class="text-xs text-muted-foreground">{field.hint}</p>
		{/if}
		{#if invalid}
			<p id={errorId(field.name)} class="text-sm text-destructive">
				{errors[field.name]?.join('. ')}
			</p>
		{/if}
	</div>
{/each}
