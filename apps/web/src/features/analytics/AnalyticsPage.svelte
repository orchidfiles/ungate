<script lang="ts">
import IconRefreshCw from 'virtual:icons/lucide/refresh-cw';
import IconTrash2 from 'virtual:icons/lucide/trash-2';

import { PERIODS } from '$shared/constants';
import { Formatter } from '$shared/formatter';

import { getAnalyticsStore } from './analytics-store.svelte';
import RequestList from './RequestList.svelte';
import StatCard from './StatCard.svelte';
import TokenChart from './TokenChart.svelte';

const store = getAnalyticsStore();

$effect(() => {
	void store.load();
});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div class="flex gap-1">
			{#each PERIODS as p}
				<button
					class="btn btn-sm {store.period === p.value ? 'preset-filled-primary-500' : 'preset-tonal-surface'}"
					onclick={() => (store.period = p.value)}>
					{p.label}
				</button>
			{/each}
		</div>

		<div class="flex gap-2">
			<button
				class="btn btn-sm preset-tonal-surface"
				onclick={() => store.load()}
				disabled={store.loading}>
				<IconRefreshCw class="size-4" />
				Refresh
			</button>
			<button
				class="btn btn-sm preset-tonal-error"
				onclick={() => store.reset()}>
				<IconTrash2 class="size-4" />
				Reset
			</button>
		</div>
	</div>

	{#if store.error}
		<div class="card preset-tonal-error p-4 text-center">
			<p class="font-medium">Error</p>
			<p class="text-sm opacity-70">{store.error}</p>
		</div>
	{/if}

	{#if store.summary}
		<div class="grid grid-cols-2 md:grid-cols-3 gap-4">
			<StatCard
				label="Total Requests"
				value={Formatter.number(store.summary.totalRequests)} />
			<StatCard
				label="Claude Code"
				value={Formatter.number(store.summary.claudeCodeRequests)}
				variant="success" />
			<StatCard
				label="Errors"
				value={Formatter.number(store.summary.errorRequests)}
				variant="error" />
		</div>

		<TokenChart requests={store.requests} />
	{/if}

	<RequestList
		requests={store.filteredRequests}
		models={store.availableModels}
		modelFilter={store.modelFilter}
		requestLimit={store.requestLimit}
		onModelFilterChange={(v) => (store.modelFilter = v)}
		onLimitChange={(v) => (store.requestLimit = v)} />
</div>
