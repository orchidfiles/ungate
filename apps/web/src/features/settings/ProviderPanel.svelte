<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconX from 'virtual:icons/lucide/x';

import ChatGPTAuthSection from '../auth/ChatGPTAuthSection.svelte';
import ClaudeAuthSection from '../auth/ClaudeAuthSection.svelte';
import MiniMaxAuthSection from '../auth/MiniMaxAuthSection.svelte';

import { getSettingsUiStore, ProviderAuthState } from './settings-ui-store.svelte';

import type { ModelMappingProvider } from '@ungate/shared/frontend';

const uiStore = getSettingsUiStore();
const providerTabs: ModelMappingProvider[] = ['claude', 'minimax', 'openai'];

const authStatusTitle: Record<ProviderAuthState, string> = {
	[ProviderAuthState.Authorized]: 'Authorized',
	[ProviderAuthState.NotAuthorized]: 'Not authorized',
	[ProviderAuthState.Loading]: 'Checking...'
};

const authStatusClass: Record<ProviderAuthState, string> = {
	[ProviderAuthState.Authorized]: 'text-success-400',
	[ProviderAuthState.NotAuthorized]: 'text-error-400',
	[ProviderAuthState.Loading]: 'text-warning-400'
};

function handleAuthStatusChange(): void {
	void uiStore.refreshAuthStates();
}
</script>

<div class="space-y-4">
	<div class="flex min-w-max gap-2 overflow-x-auto">
		{#each providerTabs as currentProvider}
			<button
				type="button"
				class="btn h-auto min-h-0 px-3 py-1.5 border {uiStore.selectedProvider === currentProvider
					? 'preset-filled-primary-500 border-primary-500/50'
					: 'preset-tonal-surface border-surface-600 hover:border-surface-400 hover:preset-filled-surface-500'}"
				onclick={() => uiStore.setSelectedProvider(currentProvider)}>
				<div class="flex items-center gap-2 text-left">
					<span class="text-sm font-medium">{uiStore.providerLabels[currentProvider]}</span>
					{#if uiStore.authStates[currentProvider] === ProviderAuthState.Loading}
						<IconLoader
							class="size-3.5 animate-spin {authStatusClass[uiStore.authStates[currentProvider]]}"
							title={authStatusTitle[uiStore.authStates[currentProvider]]}
							aria-label={authStatusTitle[uiStore.authStates[currentProvider]]} />
					{:else if uiStore.authStates[currentProvider] === ProviderAuthState.Authorized}
						<IconCheck
							class="size-3.5 {authStatusClass[uiStore.authStates[currentProvider]]}"
							title={authStatusTitle[uiStore.authStates[currentProvider]]}
							aria-label={authStatusTitle[uiStore.authStates[currentProvider]]} />
					{:else}
						<IconX
							class="size-3.5 {authStatusClass[uiStore.authStates[currentProvider]]}"
							title={authStatusTitle[uiStore.authStates[currentProvider]]}
							aria-label={authStatusTitle[uiStore.authStates[currentProvider]]} />
					{/if}
				</div>
			</button>
		{/each}
	</div>

	{#if uiStore.selectedProvider === 'claude'}
		<ClaudeAuthSection onAuthStatusChange={handleAuthStatusChange} />
	{:else if uiStore.selectedProvider === 'openai'}
		<ChatGPTAuthSection onAuthStatusChange={handleAuthStatusChange} />
	{:else}
		<MiniMaxAuthSection onAuthStatusChange={handleAuthStatusChange} />
	{/if}
</div>
