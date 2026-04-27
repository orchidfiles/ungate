<script lang="ts">
import { getProviderLabel } from '@ungate/shared/frontend';
import IconCopy from 'virtual:icons/lucide/copy';
import IconTrash2 from 'virtual:icons/lucide/trash-2';

import type { ModelMappingConfig, ModelMappingProvider } from '@ungate/shared/frontend';

interface VisibleModelItem {
	model: ModelMappingConfig;
	index: number;
}

interface Props {
	selectedProvider: ModelMappingProvider;
	models: ModelMappingConfig[];
	onModelsChange: (nextModels: ModelMappingConfig[]) => void;
	onSave: () => void;
	saving: boolean;
	saved: boolean;
	restarting: boolean;
}

let { selectedProvider, models, onModelsChange, onSave, saving, saved, restarting }: Props = $props();

let copiedId = $state<string | null>(null);
let confirmDeleteModelId = $state<string | null>(null);
let confirmDeleteIndex = $state<number | null>(null);
let activeModelIndex = $state<number | null>(null);

const reasoningOptions: { label: string; value: ModelMappingConfig['reasoningBudget'] }[] = [
	{ label: 'None', value: null },
	{ label: 'Low', value: 'low' },
	{ label: 'Medium', value: 'medium' },
	{ label: 'High', value: 'high' },
	{ label: 'XHigh', value: 'xhigh' }
];

function withSortOrder(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => ({ ...model, sortOrder: index }));
}

function commit(nextModels: ModelMappingConfig[]) {
	onModelsChange(withSortOrder(nextModels));
}

function visibleModels(): VisibleModelItem[] {
	return models.map((model, index) => ({ model, index })).filter((item) => item.model.provider === selectedProvider);
}

function activeVisibleModel(): VisibleModelItem | null {
	if (activeModelIndex === null) {
		return null;
	}

	const active = visibleModels().find((item) => item.index === activeModelIndex);

	if (!active) {
		return null;
	}

	return active;
}

function modelTitle(item: VisibleModelItem): string {
	if (item.model.label.trim()) {
		return item.model.label;
	}

	if (item.model.id.trim()) {
		return item.model.id;
	}

	return `Model ${item.index + 1}`;
}

function setActiveModel(index: number) {
	if (activeModelIndex === index) {
		activeModelIndex = null;

		return;
	}

	activeModelIndex = index;
}

function addModel() {
	const nextIndex = models.length;

	commit([
		...models,
		{
			id: '',
			label: '',
			provider: selectedProvider,
			upstreamModel: '',
			sortOrder: models.length,
			reasoningBudget: null,
			enabled: true
		}
	]);

	activeModelIndex = nextIndex;
}

function inputValue(event: Event): string {
	const target = event.target;

	if (!target || !(target instanceof HTMLInputElement)) {
		return '';
	}

	return target.value;
}

function selectValue(event: Event): string {
	const target = event.target;

	if (!target || !(target instanceof HTMLSelectElement)) {
		return '';
	}

	return target.value;
}

function updateModelAtIndex(index: number, key: keyof ModelMappingConfig, value: string | number | null) {
	commit(
		models.map((model, modelIndex) => {
			if (modelIndex !== index) {
				return model;
			}

			if (key === 'reasoningBudget') {
				if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === null) {
					return { ...model, reasoningBudget: value };
				}

				return { ...model, reasoningBudget: null };
			}

			return { ...model, [key]: value };
		})
	);
}

async function copyModelId(id: string) {
	if (!id.trim()) {
		return;
	}

	await navigator.clipboard.writeText(id);
	copiedId = id;
	setTimeout(() => {
		if (copiedId === id) {
			copiedId = null;
		}
	}, 1500);
}

function requestDelete(id: string, index: number) {
	confirmDeleteModelId = id;
	confirmDeleteIndex = index;
}

function cancelDelete() {
	confirmDeleteModelId = null;
	confirmDeleteIndex = null;
}

function confirmDelete() {
	if (confirmDeleteIndex === null) {
		return;
	}

	commit(models.filter((_, modelIndex) => modelIndex !== confirmDeleteIndex));
	cancelDelete();
}

$effect(() => {
	const visible = visibleModels();

	if (visible.length === 0) {
		activeModelIndex = null;

		return;
	}

	const active = visible.find((item) => item.index === activeModelIndex);

	if (!active) {
		activeModelIndex = visible[0].index;
	}
});
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<div class="flex items-center justify-between gap-3">
		<div class="space-y-1">
			<p class="text-sm font-semibold">Models · {getProviderLabel(selectedProvider)}</p>
			<p class="text-xs text-surface-400"> Use these IDs when adding custom models in Cursor. </p>
		</div>
		<div class="flex items-center gap-2">
			<button
				class="btn btn-sm preset-filled-primary-500"
				type="button"
				onclick={addModel}>
				Add Model
			</button>
			<button
				class="btn btn-sm preset-filled-primary-500"
				type="button"
				onclick={onSave}
				disabled={saving || restarting}>
				{saved ? 'Saved' : 'Save'}
			</button>
		</div>
	</div>

	<div class="space-y-3">
		{#if visibleModels().length === 0}
			<div class="card preset-tonal-surface border border-surface-700/30 p-4 text-sm text-surface-400">
				No models for {getProviderLabel(selectedProvider)}.
			</div>
		{:else}
			<div>
				<div class="flex flex-wrap gap-2">
					{#each visibleModels() as item}
						<button
							type="button"
							class="btn btn-sm h-auto min-h-0 px-3 py-1.5 border {activeModelIndex === item.index
								? 'preset-filled-primary-500 border-primary-500/50'
								: 'preset-tonal-surface border-surface-600 hover:border-surface-400 hover:preset-filled-surface-500'}"
							onclick={() => setActiveModel(item.index)}>
							{modelTitle(item)}
						</button>
					{/each}
				</div>
			</div>

			{#if activeVisibleModel()}
				{@const activeItem = activeVisibleModel()!}
				{@const model = activeItem.model}
				{@const index = activeItem.index}
				<div class="card preset-tonal-surface border border-surface-700/30 p-4 space-y-3">
					<div class="flex items-center justify-between gap-3">
						<p class="text-sm font-medium">{modelTitle(activeItem)}</p>
						<div class="flex items-center gap-2">
							<button
								class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
								type="button"
								onclick={() => void copyModelId(model.id)}
								disabled={!model.id.trim()}>
								<IconCopy class="size-4" />
								{copiedId === model.id ? 'Copied' : 'Copy ID'}
							</button>
							<button
								class="btn btn-sm preset-outlined-error-500"
								type="button"
								onclick={() => requestDelete(model.id || `#row-${index + 1}`, index)}>
								<IconTrash2 class="size-4" />
								Remove
							</button>
						</div>
					</div>

					<div class="grid grid-cols-1 gap-4 xl:grid-cols-4 md:grid-cols-2">
						<label class="label">
							<span class="label-text text-xs">Model ID</span>
							<input
								class="input text-sm font-mono"
								type="text"
								value={model.id}
								oninput={(event) => updateModelAtIndex(index, 'id', inputValue(event))}
								placeholder="sonnet-4.6" />
						</label>

						<label class="label">
							<span class="label-text text-xs">Label</span>
							<input
								class="input text-sm"
								type="text"
								value={model.label}
								oninput={(event) => updateModelAtIndex(index, 'label', inputValue(event))}
								placeholder="Sonnet 4.6" />
						</label>

						<label class="label xl:col-span-1 md:col-span-2">
							<span class="label-text text-xs">Upstream Model</span>
							<input
								class="input text-sm font-mono"
								type="text"
								value={model.upstreamModel}
								oninput={(event) => updateModelAtIndex(index, 'upstreamModel', inputValue(event))}
								placeholder={selectedProvider === 'minimax' ? 'MiniMax-M2.7' : 'claude-sonnet-4-6'} />
						</label>

						<label class="label">
							<span class="label-text text-xs">Reasoning Budget</span>
							<select
								class="select text-sm"
								value={model.reasoningBudget ?? ''}
								onchange={(event) => {
									const value = selectValue(event);
									updateModelAtIndex(index, 'reasoningBudget', value ? value : null);
								}}>
								{#each reasoningOptions as option}
									<option value={option.value ?? ''}>{option.label}</option>
								{/each}
							</select>
						</label>
					</div>
				</div>
			{/if}
		{/if}
	</div>
</div>

{#if confirmDeleteModelId}
	<div class="fixed inset-0 z-30 flex items-center justify-center bg-surface-950/70 p-4">
		<div class="card preset-tonal-surface border border-surface-700/30 w-full max-w-md p-5 space-y-4">
			<p class="text-sm font-semibold">Remove model</p>
			<p class="text-sm text-surface-400">
				Confirm deletion for Model ID:
				<code class="code text-surface-950-50">{confirmDeleteModelId}</code>
			</p>
			<div class="flex justify-end gap-2">
				<button
					class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
					type="button"
					onclick={cancelDelete}>
					Cancel
				</button>
				<button
					class="btn btn-sm preset-outlined-error-500"
					type="button"
					disabled={confirmDeleteIndex === null}
					onclick={confirmDelete}>
					<IconTrash2 class="size-4" />
					Remove
				</button>
			</div>
		</div>
	</div>
{/if}
