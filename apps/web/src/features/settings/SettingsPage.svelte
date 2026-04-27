<script lang="ts">
import TunnelPanel from '../tunnel/TunnelPanel.svelte';

import ModelsSection from './ModelsSection.svelte';
import ProviderPanel from './ProviderPanel.svelte';
import { getSettingsStore } from './settings-store.svelte';
import { getSettingsUiStore } from './settings-ui-store.svelte';

import type { AppSettings, ModelMappingConfig, ModelMappingProvider } from '@ungate/shared/frontend';

const store = getSettingsStore();
const uiStore = getSettingsUiStore();

let port = $state('');
let apiKey = $state('');
let quiet = $state(false);
let extraInstruction = $state('');
let models = $state<ModelMappingConfig[]>([]);
let showAdvanced = $state(false);
let validationError = $state<string | null>(null);

function cloneModels(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => {
		let reasoningBudget = model.reasoningBudget;
		let provider: ModelMappingProvider = 'claude';

		if (model.provider === 'minimax') {
			provider = 'minimax';
		}

		if (model.provider === 'openai') {
			provider = 'openai';
		}

		if (reasoningBudget !== 'low' && reasoningBudget !== 'medium' && reasoningBudget !== 'high' && reasoningBudget !== 'xhigh') {
			reasoningBudget = null;
		}

		return { ...model, provider, reasoningBudget, sortOrder: index };
	});
}

function withSortOrder(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => ({ ...model, sortOrder: index }));
}

function currentValues(): Partial<AppSettings> {
	const values: Partial<AppSettings> = {
		port: parseInt(port, 10),
		quiet,
		models: cloneModels(models)
	};

	values.apiKey = apiKey.trim() || null;
	values.extraInstruction = extraInstruction.trim() || null;

	return values;
}

function validateBeforeSave(): string | null {
	const parsedPort = parseInt(port, 10);

	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
		return 'Port must be an integer between 1 and 65535.';
	}

	for (const model of models) {
		if (!model.id.trim()) {
			return 'Every model must have a Model ID.';
		}

		if (!model.label.trim()) {
			return `Model "${model.id}" must have a label.`;
		}

		if (!model.upstreamModel.trim()) {
			return `Model "${model.id}" must have an upstream model.`;
		}
	}

	return null;
}

function handleSaveAndRestart() {
	validationError = validateBeforeSave();

	if (validationError) {
		return;
	}

	void store.saveAndRestart(currentValues());
}

function handleSaveWithoutRestart() {
	validationError = validateBeforeSave();

	if (validationError) {
		return;
	}

	if (store.restarting) {
		store.completeRestart();
	}

	void store.save(currentValues());
}

$effect(() => {
	void store.load();
});

$effect(() => {
	if (!store.settings) {
		return;
	}

	port = String(store.settings.port);
	apiKey = store.settings.apiKey ?? '';
	quiet = store.settings.quiet;
	extraInstruction = store.settings.extraInstruction ?? '';
	models = cloneModels(store.settings.models);
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
						bind:value={port} />
				</label>
				<label class="label">
					<span class="label-text text-xs">API Key</span>
					<input
						class="input text-sm"
						type="text"
						bind:value={apiKey}
						placeholder="No key (open access)" />
				</label>
			</div>
		</div>

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
						bind:value={extraInstruction}
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
				models={models}
				onSave={handleSaveWithoutRestart}
				saving={store.saving}
				saved={store.saved}
				restarting={store.restarting}
				onModelsChange={(nextModels) => {
					models = withSortOrder(nextModels);
				}} />
		</div>
	{/if}
</div>
