<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';
import IconSave from 'virtual:icons/lucide/save';

import ClaudeAuthSection from '../auth/ClaudeAuthSection.svelte';
import MiniMaxAuthSection from '../auth/MiniMaxAuthSection.svelte';
import TunnelPanel from '../tunnel/TunnelPanel.svelte';

import { getSettingsStore } from './settings-store.svelte';

import type { AppSettings } from '@ungate/shared/frontend';

const store = getSettingsStore();

let port = $state('');
let apiKey = $state('');
let quiet = $state(false);
let extraInstruction = $state('');

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
});

function currentValues(): Partial<AppSettings> {
	const values: Partial<AppSettings> = {
		port: parseInt(port, 10),
		quiet
	};

	values.apiKey = apiKey.trim() || null;
	values.extraInstruction = extraInstruction.trim() || null;

	return values;
}

function handleSave() {
	void store.save(currentValues());
}

function handleSaveAndRestart() {
	void store.saveAndRestart(currentValues());
}
</script>

<div class="space-y-6">
	<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
		<ClaudeAuthSection />
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
