<script lang="ts">
import IconExternalLink from 'virtual:icons/lucide/external-link';
import IconLoader from 'virtual:icons/lucide/loader-circle';

import { getSettingsUiStore } from '../settings/settings-ui-store.svelte';

import { getAccountStore } from './account-store.svelte';
import AccountManager from './AccountManager.svelte';

const store = getAccountStore('claude');
const uiStore = getSettingsUiStore();

let codeInput = $state('');

// Keep the provider tab indicator in sync with polled account state (automatic switches, other windows).
$effect(() => {
	uiStore.setAuthorized('claude', store.authorized);
});

// A finished, cancelled or restarted login must not leave a stale code behind.
$effect(() => {
	if (store.login.phase === 'idle' || store.login.phase === 'starting') {
		codeInput = '';
	}
});

function handleComplete(): void {
	void store.completeWithCode(codeInput);
}

function handleKeydown(event: KeyboardEvent): void {
	if (event.key === 'Enter' && codeInput.trim() && store.login.phase === 'awaiting') {
		event.preventDefault();
		handleComplete();
	}
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5">
	<AccountManager
		store={store}
		providerName="Claude"
		providerSite="claude.ai">
		{#snippet loginPanel()}
			<div class="space-y-3">
				<div class="flex flex-wrap items-center gap-2 text-sm text-surface-400">
					{#if store.login.authUrl}
						<a
							href={store.login.authUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="anchor flex items-center gap-1">
							<IconExternalLink class="size-3.5" />
							Open authorization page
						</a>
						<span>— approve access, then paste the code shown by Claude below.</span>
					{:else}
						<span>Paste the code shown by Claude below.</span>
					{/if}
				</div>
				<input
					class="input text-sm font-mono"
					type="text"
					autocomplete="off"
					spellcheck="false"
					aria-label="Claude authorization code"
					bind:value={codeInput}
					onkeydown={handleKeydown}
					disabled={store.login.phase === 'completing'}
					placeholder="CODE#STATE" />
				<div class="flex gap-2">
					<button
						class="btn btn-sm preset-filled-primary-500"
						type="button"
						onclick={handleComplete}
						disabled={store.login.phase === 'completing' || !codeInput.trim()}>
						{#if store.login.phase === 'completing'}
							<IconLoader class="size-4 animate-spin" />
							Verifying...
						{:else}
							Confirm
						{/if}
					</button>
					<button
						class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
						type="button"
						onclick={() => void store.cancelLogin()}
						disabled={store.login.phase === 'completing'}>
						Cancel
					</button>
				</div>
			</div>
		{/snippet}
	</AccountManager>
</div>
