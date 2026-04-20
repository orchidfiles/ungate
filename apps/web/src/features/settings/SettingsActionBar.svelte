<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';
import IconSave from 'virtual:icons/lucide/save';

import { getSettingsStore } from './settings-store.svelte';

const store = getSettingsStore();

interface Props {
	onSave: () => void;
	onSaveAndRestart: () => void;
}

let { onSave, onSaveAndRestart }: Props = $props();
</script>

<div class="sticky top-0 z-20 border-b border-surface-700/40 bg-surface-900/60 py-3 backdrop-blur-sm">
	<div class="flex flex-wrap items-center justify-end gap-2">
		<button
			class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
			type="button"
			onclick={onSave}
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
			type="button"
			onclick={onSaveAndRestart}
			disabled={store.saving || store.restarting}>
			<IconRotateCcw class="size-4 {store.restarting ? 'animate-spin' : ''}" />
			{store.restarting ? 'Restarting...' : 'Save & Restart'}
		</button>
	</div>
	{#if store.statusMessage}
		<p class="mt-2 text-right text-xs text-surface-400">{store.statusMessage}</p>
	{/if}
</div>
