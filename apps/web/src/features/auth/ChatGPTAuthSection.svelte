<script lang="ts">
import IconExternalLink from 'virtual:icons/lucide/external-link';
import IconLoader from 'virtual:icons/lucide/loader-circle';

import { getSettingsUiStore } from '../settings/settings-ui-store.svelte';

import { getAccountStore } from './account-store.svelte';
import AccountManager from './AccountManager.svelte';

const store = getAccountStore('openai');
const uiStore = getSettingsUiStore();

// Keep the provider tab indicator in sync with polled account state (automatic switches, other windows).
$effect(() => {
	uiStore.setAuthorized('openai', store.authorized);
});
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5">
	<AccountManager
		store={store}
		providerName="ChatGPT"
		providerSite="chatgpt.com">
		{#snippet loginPanel()}
			<div class="space-y-3">
				<div class="flex items-center gap-2 text-sm text-surface-400">
					<IconLoader class="size-4 animate-spin" />
					{#if store.login.resumed}
						Waiting for the pending ChatGPT login to finish in the browser...
					{:else}
						Waiting for authorization in the browser...
					{/if}
				</div>
				<div class="flex flex-wrap items-center gap-3">
					{#if store.login.authUrl}
						<a
							href={store.login.authUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="anchor flex items-center gap-1 text-sm">
							<IconExternalLink class="size-3.5" />
							Open authorization page again
						</a>
					{/if}
					<button
						class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
						type="button"
						onclick={() => void store.cancelLogin()}>
						{store.login.resumed ? 'Cancel that login' : 'Cancel'}
					</button>
				</div>
			</div>
		{/snippet}
	</AccountManager>
</div>
