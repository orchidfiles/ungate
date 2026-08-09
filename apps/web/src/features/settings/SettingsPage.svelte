<script lang="ts">
import { isValidBodyLimitMb, MAX_BODY_LIMIT_MB, MIN_BODY_LIMIT_MB } from '@ungate/shared/frontend';

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
let extraInstruction = $state('');
let bodyLimitMb = $state('');
let models = $state<ModelMappingConfig[]>([]);
let showAdvanced = $state(false);
let validationError = $state<string | null>(null);

function cloneModels(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => {
		let reasoningBudget = model.reasoningBudget;
		let serviceTier = model.serviceTier;
		let provider: ModelMappingProvider = 'claude';

		if (model.provider === 'minimax') {
			provider = 'minimax';
		}

		if (model.provider === 'openai') {
			provider = 'openai';
		}

		if (
			reasoningBudget !== 'none' &&
			reasoningBudget !== 'low' &&
			reasoningBudget !== 'medium' &&
			reasoningBudget !== 'high' &&
			reasoningBudget !== 'xhigh' &&
			reasoningBudget !== 'max'
		) {
			reasoningBudget = null;
		}

		if (serviceTier !== 'default' && serviceTier !== 'priority') {
			serviceTier = null;
		}

		return { ...model, provider, reasoningBudget, serviceTier, sortOrder: index };
	});
}

function withSortOrder(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => ({ ...model, sortOrder: index }));
}

function serverValues(): Partial<AppSettings> {
	return {
		port: parseInt(port, 10),
		apiKey: apiKey.trim() || null,
		bodyLimitMb: parseInt(bodyLimitMb, 10)
	};
}

function instructionValues(): Partial<AppSettings> {
	return { extraInstruction: extraInstruction.trim() || null };
}

function modelValues(): Partial<AppSettings> {
	return { models: cloneModels(models) };
}

function validateBeforeSave(): string | null {
	const parsedPort = parseInt(port, 10);

	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
		return 'Port must be an integer between 1 and 65535.';
	}

	if (!isValidBodyLimitMb(parseInt(bodyLimitMb, 10))) {
		return `Max request size must be an integer between ${MIN_BODY_LIMIT_MB} and ${MAX_BODY_LIMIT_MB} MB.`;
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

	void store.saveAndRestart(serverValues());
}

function handleSaveWithoutRestart() {
	validationError = validateBeforeSave();

	if (validationError) {
		return;
	}

	if (store.restarting) {
		store.completeRestart();
	}

	void store.save(instructionValues());
}

function handleModelsSave() {
	validationError = validateBeforeSave();

	if (validationError) {
		return;
	}

	void store.save(modelValues());
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
	extraInstruction = store.settings.extraInstruction ?? '';
	bodyLimitMb = String(store.settings.bodyLimitMb);
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
				<label class="label">
					<span class="label-text text-xs">Max request size (MB)</span>
					<input
						class="input text-sm"
						type="number"
						min={MIN_BODY_LIMIT_MB}
						max={MAX_BODY_LIMIT_MB}
						bind:value={bodyLimitMb} />
					<span class="text-xs text-surface-400">
						Requests larger than this are rejected. Images are sent inline, so a few attachments can add several MB. The new limit
						takes effect after the server restarts.
					</span>
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
				error={store.error}
				onSave={handleModelsSave}
				saving={store.saving}
				saved={store.saved}
				restarting={store.restarting}
				onModelsChange={(nextModels) => {
					models = withSortOrder(nextModels);
				}} />
		</div>
	{/if}
</div>
