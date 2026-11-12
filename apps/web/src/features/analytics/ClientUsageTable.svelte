<script lang="ts">
import { Formatter } from '$shared/formatter';

import type { ClientUsage } from '@ungate/shared/frontend';

let { clients }: { clients: ClientUsage[] } = $props();
</script>

<div class="card preset-tonal-surface border border-surface-700/30">
	<div class="p-4 border-b border-surface-700/30 text-sm font-semibold">Usage by client</div>

	{#if clients.length === 0}
		<div class="p-8 text-center text-surface-400 text-sm">No requests in this period</div>
	{:else}
		<table class="w-full text-sm">
			<thead class="text-xs text-surface-400">
				<tr>
					<th class="p-3 text-left font-normal">Client</th>
					<th class="p-3 text-right font-normal">Requests</th>
					<th class="p-3 text-right font-normal">Input</th>
					<th class="p-3 text-right font-normal">Cache read</th>
					<th class="p-3 text-right font-normal">Output</th>
					<th class="p-3 text-right font-normal">Errors</th>
					<th class="p-3 text-right font-normal">Last request</th>
				</tr>
			</thead>
			<tbody>
				{#each clients as row (row.clientId ?? '')}
					<tr class="border-t border-surface-700/30">
						<td class="p-3">{row.label ?? (row.clientId ? row.clientId : 'Not attributed')}</td>
						<td class="p-3 text-right">{Formatter.number(row.requests)}</td>
						<td class="p-3 text-right">{Formatter.number(row.inputTokens)}</td>
						<td class="p-3 text-right">{Formatter.number(row.cacheReadTokens)}</td>
						<td class="p-3 text-right">{Formatter.number(row.outputTokens)}</td>
						<td class="p-3 text-right">{Formatter.number(row.errors)}</td>
						<td class="p-3 text-right text-xs text-surface-400">{row.lastRequestAt ? Formatter.date(row.lastRequestAt) : ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>
