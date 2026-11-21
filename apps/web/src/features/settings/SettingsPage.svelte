<script lang="ts">
import TunnelPanel from '../tunnel/TunnelPanel.svelte';

import ClientsPanel from './ClientsPanel.svelte';
import ModelsSection from './ModelsSection.svelte';
import ProviderPanel from './ProviderPanel.svelte';
import { getSettingsFormStore } from './settings-form-store.svelte';
import { getSettingsStore } from './settings-store.svelte';
import { getSettingsUiStore } from './settings-ui-store.svelte';

const store = getSettingsStore();
const formStore = getSettingsFormStore();
const uiStore = getSettingsUiStore();

let showAdvanced = $state(false);
let validationError = $state<string | null>(null);

function handleSaveAndRestart() {
	validationError = formStore.validate();

	if (validationError) {
		return;
	}

	void store.saveAndRestart(formStore.toSavePayload());
}

function handleSaveWithoutRestart() {
	validationError = formStore.validate();

	if (validationError) {
		return;
	}

	if (store.restarting) {
		store.completeRestart();
	}

	void store.save(formStore.toSavePayload());
}

$effect(() => {
	void store.load();
});

$effect(() => {
	if (!store.settings) {
		return;
	}

	formStore.syncFromAppSettings(store.settings);
});

$effect(() => {
	void uiStore.refreshAuthStates();
});
</script>

<div class="mx-auto max-w-6xl space-y-6 pb-20">
	{#if store.error}
		<div class="card preset-tonal-error p-4 text-center">
			<p class="font-medium">Error</p>
			<p class="text-sm opacity-70">{store.error}</p>
		</div>
	{/if}

	{#if validationError}
		<div class="card preset-tonal-error p-4 text-center">
			<p class="font-medium">Validation Error</p>
			<p class="text-sm opacity-70">{validationError}</p>
		</div>
	{/if}

	{#if store.settings}
		<TunnelPanel />

		<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
			<div class="flex items-center justify-between gap-3">
				<p class="text-sm font-semibold">Server Configuration</p>
				<button
					class="btn btn-sm preset-filled-primary-500"
					type="button"
					onclick={handleSaveAndRestart}
					disabled={store.saving || store.restarting}>
					{store.restarting ? 'Restarting...' : 'Save & Restart'}
				</button>
			</div>
			<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
				<label class="label">
					<span class="label-text text-xs">Port</span>
					<input
						class="input text-sm"
						type="number"
						value={formStore.port}
						oninput={(event) => formStore.setPort(event.currentTarget.value)} />
				</label>
				<label class="label">
					<span class="label-text text-xs">API Key</span>
					<input
						class="input text-sm"
						type="text"
						value={formStore.apiKey}
						oninput={(event) => formStore.setApiKey(event.currentTarget.value)}
						placeholder="No key (open access)" />
				</label>
			</div>
		</div>

		<ClientsPanel />

		<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="text-sm font-semibold">Global Instruction</p>
					<p class="text-xs text-surface-400">Extra instruction applies to all proxied requests.</p>
				</div>
				<button
					type="button"
					class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
					onclick={() => (showAdvanced = !showAdvanced)}>
					{showAdvanced ? 'Hide' : 'Show'}
				</button>
			</div>
			{#if showAdvanced}
				<div class="space-y-3">
					<textarea
						class="textarea text-sm"
						rows={4}
						value={formStore.extraInstruction}
						oninput={(event) => formStore.setExtraInstruction(event.currentTarget.value)}
						placeholder="Additional system instruction appended to every request..."></textarea>
					<div class="flex justify-end">
						<button
							class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
							type="button"
							onclick={handleSaveWithoutRestart}
							disabled={store.saving || store.restarting}>
							{store.saved ? 'Saved' : 'Save'}
						</button>
					</div>
				</div>
			{/if}
		</div>

		<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
			<p class="text-sm font-semibold">Provider</p>
			<ProviderPanel />
			<ModelsSection
				selectedProvider={uiStore.selectedProvider}
				onSave={handleSaveWithoutRestart}
				saving={store.saving}
				saved={store.saved}
				restarting={store.restarting}
				error={store.error} />
		</div>
	{/if}
</div>
