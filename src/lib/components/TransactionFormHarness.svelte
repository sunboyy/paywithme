<script lang="ts">
	// Test-only harness: constructs a client `superForm` INSIDE component init
	// (superForm registers an onDestroy, so it can't be built in plain test code)
	// and renders <TransactionForm/> exactly as a route page does. Lives next to
	// the component (not under ui/**); imported only by the a11y test.
	import { superForm, type SuperValidated } from 'sveltekit-superforms';
	import type { TransactionInput } from '$lib/schemas/transaction';
	import TransactionForm, {
		type FormMember,
		type FormCategory,
		type FormCurrency
	} from './TransactionForm.svelte';

	let {
		seeded,
		members,
		categories,
		currency,
		onform
	}: {
		seeded: SuperValidated<TransactionInput>;
		members: FormMember[];
		categories: { spending: FormCategory[]; transfer: FormCategory[] };
		currency: FormCurrency;
		/** Hand the live superForm back to the test so it can drive the error store. */
		onform?: (form: ReturnType<typeof superForm<TransactionInput>>) => void;
	} = $props();

	// Each harness instance gets a unique superForm id so parallel test renders
	// don't collide on the default (random-but-shared-across-renders) id.
	// svelte-ignore state_referenced_locally
	const form = superForm(seeded, {
		dataType: 'json',
		id: `txn-form-${Math.random().toString(36).slice(2)}`
	});
	// svelte-ignore state_referenced_locally
	onform?.(form);
</script>

<TransactionForm {form} {members} {categories} {currency} />
