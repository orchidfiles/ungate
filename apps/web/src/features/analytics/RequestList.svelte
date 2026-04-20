<script lang="ts">
import { Formatter } from '$shared/formatter';

import { formatModelName, getAnalyticsStore } from './analytics-store.svelte';

const limits = [20, 50, 100];
const store = getAnalyticsStore();

const sourceClasses: Record<string, string> = {
	claude: 'preset-filled-success-500',
	minimax: 'preset-filled-warning-500',
	error: 'preset-filled-error-500'
};

function handleModelChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	store.modelFilter = target.value;
}

function handleProviderChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	store.providerFilter = target.value as typeof store.providerFilter;
}

function handleLimitChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	store.requestLimit = parseInt(target.value, 10);
}
</script>

<div class="flex items-center gap-3 mb-4">
	<span class="text-surface-400 text-sm">Provider:</span>
	<select
		class="select w-auto text-sm border border-surface-700/30"
		value={store.providerFilter}
		onchange={handleProviderChange}>
		{#each store.availableProviders as provider}
			<option value={provider.value}>{provider.label}</option>
		{/each}
	</select>

	<span class="text-surface-400 text-sm">Model:</span>
	<select
		class="select w-auto text-sm border border-surface-700/30"
		value={store.modelFilter}
		onchange={handleModelChange}>
		<option value="">All Models</option>
		{#each store.availableModels as model}
			<option value={model.value}>{model.label}</option>
		{/each}
	</select>

	<span class="text-surface-400 text-sm">Limit:</span>
	<select
		class="select w-auto text-sm border border-surface-700/30"
		value={store.requestLimit}
		onchange={handleLimitChange}>
		{#each limits as limit}
			<option value={limit}>{limit}</option>
		{/each}
	</select>
</div>

<div class="card preset-tonal-surface border border-surface-700/30">
	<div class="p-4 border-b border-surface-700/30 text-sm font-semibold">Recent Requests</div>

	{#if store.filteredRequests.length === 0}
		<div class="p-8 text-center text-surface-400 text-sm">No requests yet</div>
	{:else}
		{#each store.filteredRequests as req (req.id)}
			<div class="p-4 border-b border-surface-700/30 last:border-b-0">
				<div class="flex items-center justify-between mb-2">
					<span class="text-primary-500 font-medium text-sm">{formatModelName(req.model)}</span>
					<span class="badge text-xs {sourceClasses[req.source] || 'preset-tonal-surface'}">{req.source}</span>
				</div>
				<div class="text-surface-400 text-xs">
					{Formatter.date(req.timestamp ?? 0)} &bull;
					{req.inputTokens} in / {req.outputTokens} out
					{#if req.latencyMs}
						&bull; {Formatter.latency(req.latencyMs)}
					{/if}
					{#if req.stream}
						&bull; stream
					{/if}
				</div>
			</div>
		{/each}
	{/if}
</div>
