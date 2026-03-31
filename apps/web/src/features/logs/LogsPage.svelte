<script lang="ts">
import { Formatter } from '$shared/formatter';

import { getLogsStore } from './logs-store.svelte';

const store = getLogsStore();

const levelClasses: Record<string, string> = {
	info: 'text-surface-400',
	warn: 'text-warning-500',
	error: 'text-error-500'
};
</script>

<div class="space-y-6">
	<div class="space-y-2">
		<div class="flex items-center justify-between">
			<p class="text-sm font-semibold">API Logs</p>
			<button
				class="btn btn-sm preset-tonal-surface"
				onclick={() => store.clearApi()}>
				Clear
			</button>
		</div>
		<div class="card preset-tonal-surface border border-surface-700/30 p-4 font-mono text-xs overflow-auto max-h-[35vh]">
			{#if store.apiLogs.length === 0}
				<p class="text-surface-400 text-center py-8">No log entries</p>
			{:else}
				{#each store.apiLogs as entry}
					<div class="py-0.5 flex gap-3">
						<span class="text-surface-500 shrink-0">{Formatter.date(entry.timestamp)}</span>
						<span class="uppercase w-12 shrink-0 {levelClasses[entry.level] || 'text-surface-400'}">{entry.level}</span>
						<span class="text-surface-200 break-all">{entry.message}</span>
					</div>
				{/each}
			{/if}
		</div>
	</div>

	<div class="space-y-2">
		<div class="flex items-center justify-between">
			<p class="text-sm font-semibold">Tunnel Logs</p>
			<button
				class="btn btn-sm preset-tonal-surface"
				onclick={() => store.clearTunnel()}>
				Clear
			</button>
		</div>
		<div class="card preset-tonal-surface border border-surface-700/30 p-4 font-mono text-xs overflow-auto max-h-[35vh]">
			{#if store.tunnelLogs.length === 0}
				<p class="text-surface-400 text-center py-8">No log entries</p>
			{:else}
				{#each store.tunnelLogs as entry}
					<div class="py-0.5 flex gap-3">
						<span class="text-surface-500 shrink-0">{Formatter.date(entry.timestamp)}</span>
						<span class="uppercase w-12 shrink-0 {levelClasses[entry.level] || 'text-surface-400'}">{entry.level}</span>
						<span class="text-surface-200 break-all">{entry.message}</span>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>
