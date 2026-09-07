<script lang="ts">
	// Sub-navigation for the account settings pages, the sibling of `GroupNav`:
	// same `TabNav` bar, same active-state rules, so "settings" navigates the same
	// way whether it is a group's settings or your account's.
	//
	// Sub-FLOWS (create an API key, edit a receiving method) deliberately do NOT
	// render this — they are one task at a time, reached and left by a back link.
	import { resolve } from '$app/paths';
	import TabNav from '$lib/components/TabNav.svelte';
	import UserIcon from '@lucide/svelte/icons/user';
	import WalletIcon from '@lucide/svelte/icons/wallet';
	import KeyIcon from '@lucide/svelte/icons/key';

	export type SettingsSection = 'account' | 'receiving' | 'api-keys';

	let { current }: { current: SettingsSection } = $props();

	const items = [
		{ key: 'account', label: 'Account', icon: UserIcon, href: resolve('/settings') },
		{
			key: 'receiving',
			label: 'Getting paid',
			icon: WalletIcon,
			href: resolve('/settings/receiving')
		},
		{ key: 'api-keys', label: 'API keys', icon: KeyIcon, href: resolve('/settings/api-keys') }
	];
</script>

<TabNav label="Settings sections" {items} {current} />
