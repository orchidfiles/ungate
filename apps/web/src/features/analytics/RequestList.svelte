<script lang="ts">
import { Formatter } from '$shared/formatter';

import type { RequestRecord } from '@ungate/shared/frontend';

interface Props {
	requests: RequestRecord[];
	models: string[];
	modelFilter: string;
	requestLimit: number;
	onModelFilterChange: (value: string) => void;
	onLimitChange: (value: number) => void;
}

let { requests, models, modelFilter, requestLimit, onModelFilterChange, onLimitChange }: Props = $props();

const limits = [20, 50, 100];

const sourceClasses: Record<string, string> = {
	claude_code: 'preset-filled-success-500',
	error: 'preset-filled-error-500'
};

function handleModelChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	onModelFilterChange(target.value);
}

function handleLimitChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	onLimitChange(parseInt(target.value, 10));
}
</script>

<div class="flex items-center gap-3 mb-4">
	<span class="text-surface-400 text-sm">Model:</span>
	<select
		class="select w-auto text-sm"
		value={modelFilter}
		onchange={handleModelChange}>
		<option value="">All Models</option>
		{#each models as model}
			<option value={model}>{model}</option>
		{/each}
	</select>

	<span class="text-surface-400 text-sm">Limit:</span>
	<select
		class="select w-auto text-sm"
		value={requestLimit}
		onchange={handleLimitChange}>
		{#each limits as limit}
			<option value={limit}>{limit}</option>
		{/each}
	</select>
</div>

<div class="card preset-tonal-surface border border-surface-700/30">
	<div class="p-4 border-b border-surface-700/30 text-sm font-semibold">Recent Requests</div>

	{#if requests.length === 0}
		<div class="p-8 text-center text-surface-400 text-sm">No requests yet</div>
	{:else}
		{#each requests as req (req.id)}
			<div class="p-4 border-b border-surface-700/30 last:border-b-0">
				<div class="flex items-center justify-between mb-2">
					<span class="text-primary-500 font-medium text-sm">{req.model}</span>
					<span class="badge text-xs {sourceClasses[req.source] || 'preset-tonal-surface'}">{req.source}</span>
				</div>
				<div class="text-surface-400 text-xs">
					{Formatter.date(req.timestamp)} &bull;
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
