<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconPlus from 'virtual:icons/lucide/plus';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';
import IconSave from 'virtual:icons/lucide/save';
import IconTrash2 from 'virtual:icons/lucide/trash-2';

import ChatGPTAuthSection from '../auth/ChatGPTAuthSection.svelte';
import ClaudeAuthSection from '../auth/ClaudeAuthSection.svelte';
import MiniMaxAuthSection from '../auth/MiniMaxAuthSection.svelte';
import TunnelPanel from '../tunnel/TunnelPanel.svelte';

import { getSettingsStore } from './settings-store.svelte';

import type { AppSettings, ModelMappingConfig, ModelMappingProvider } from '@ungate/shared/frontend';

const store = getSettingsStore();

let port = $state('');
let apiKey = $state('');
let quiet = $state(false);
let extraInstruction = $state('');
let models = $state<ModelMappingConfig[]>([]);

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

		if (reasoningBudget !== 'low' && reasoningBudget !== 'medium' && reasoningBudget !== 'high') {
			reasoningBudget = null;
		}

		return { ...model, provider, reasoningBudget, sortOrder: index };
	});
}

function createEmptyModel(): ModelMappingConfig {
	return {
		id: '',
		label: '',
		provider: 'claude',
		upstreamModel: '',
		enabled: true,
		sortOrder: models.length,
		reasoningBudget: null
	};
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

function addModel() {
	models = [...models, createEmptyModel()];
}

function removeModel(index: number) {
	models = models.filter((_, modelIndex) => modelIndex !== index);
}

function handleSave() {
	void store.save(currentValues());
}

function handleSaveAndRestart() {
	void store.saveAndRestart(currentValues());
}
</script>

<div class="space-y-6">
	<div class="grid grid-cols-1 gap-4">
		<ClaudeAuthSection />
		<ChatGPTAuthSection />
		<MiniMaxAuthSection />
	</div>

	<TunnelPanel />

	{#if store.error}
		<div class="card preset-tonal-error p-4 text-center">
			<p class="font-medium">Error</p>
			<p class="text-sm opacity-70">{store.error}</p>
		</div>
	{/if}

	{#if store.settings}
		<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
			<p class="text-sm font-semibold">Server Configuration</p>

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
			<p class="text-sm font-semibold">Extra Instruction</p>
			<textarea
				class="textarea text-sm"
				rows={4}
				bind:value={extraInstruction}
				placeholder="Additional system instruction appended to every request..."></textarea>
		</div>

		<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
			<div class="flex items-center justify-between gap-3">
				<div class="space-y-1">
					<p class="text-sm font-semibold">Models</p>
					<p class="text-xs text-surface-400"> Use these IDs when adding custom models in Cursor. </p>
				</div>
				<button
					class="btn btn-sm preset-filled-primary-500"
					type="button"
					onclick={addModel}>
					<IconPlus class="size-4" />
					Add Model
				</button>
			</div>

			<div class="space-y-4">
				{#if models.length === 0}
					<div class="card preset-tonal-surface border border-surface-700/30 p-4 text-sm text-surface-400">
						No custom models configured.
					</div>
				{:else}
					{#each models as model, index}
						<div class="card preset-tonal-surface border border-surface-700/30 p-4 space-y-4">
							<div class="flex items-center justify-between gap-3">
								<p class="text-sm font-medium">{model.label || `Model ${index + 1}`}</p>
								<button
									class="btn btn-sm preset-outlined-error-500"
									type="button"
									onclick={() => removeModel(index)}>
									<IconTrash2 class="size-4" />
									Remove
								</button>
							</div>

							<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
								<label class="label">
									<span class="label-text text-xs">Model ID</span>
									<input
										class="input text-sm font-mono"
										type="text"
										bind:value={model.id}
										placeholder="sonnet-4.6" />
								</label>

								<label class="label">
									<span class="label-text text-xs">Label</span>
									<input
										class="input text-sm"
										type="text"
										bind:value={model.label}
										placeholder="Sonnet 4.6" />
								</label>

								<label class="label">
									<span class="label-text text-xs">Provider</span>
									<select
										class="select text-sm"
										bind:value={model.provider}>
										<option value="claude">Claude</option>
										<option value="minimax">MiniMax</option>
										<option value="openai">OpenAI</option>
									</select>
								</label>

								<label class="label md:col-span-2">
									<span class="label-text text-xs">Upstream Model</span>
									<input
										class="input text-sm font-mono"
										type="text"
										bind:value={model.upstreamModel}
										placeholder={model.provider === 'minimax' ? 'MiniMax-M2.7' : 'claude-sonnet-4-6'} />
								</label>

								<label class="label">
									<span class="label-text text-xs">Reasoning Budget</span>
									<select
										class="select text-sm"
										bind:value={model.reasoningBudget}>
										<option value="">None</option>
										<option value="low">Low</option>
										<option value="medium">Medium</option>
										<option value="high">High</option>
									</select>
								</label>

								<label class="label flex items-center gap-2 pt-6">
									<input
										class="checkbox"
										type="checkbox"
										bind:checked={model.enabled} />
									<span class="label-text text-xs">Published in `/v1/models`</span>
								</label>
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<div class="flex justify-end gap-2">
			<button
				class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
				onclick={handleSave}
				disabled={store.saving || store.restarting}>
				{#if store.saved}
					<IconCheck class="size-4" />
					Saved
				{:else}
					<IconSave class="size-4" />
					Save
				{/if}
			</button>
			<button
				class="btn btn-sm preset-filled-primary-500"
				onclick={handleSaveAndRestart}
				disabled={store.saving || store.restarting}>
				<IconRotateCcw class="size-4 {store.restarting ? 'animate-spin' : ''}" />
				{store.restarting ? 'Restarting...' : 'Save & Restart'}
			</button>
		</div>
	{/if}
</div>
