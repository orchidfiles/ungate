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

let confirmReset = $state(false);

$effect(() => {
	void store.load();
});

function handleReset() {
	confirmReset = true;
}

function handleConfirmReset() {
	confirmReset = false;
	void store.reset();
}
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
				onclick={handleReset}>
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
		<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
			<StatCard
				label="Total Requests"
				value={Formatter.number(store.summary.totalRequests)} />
			<StatCard
				label="Claude"
				value={Formatter.number(store.summary.claudeRequests)}
				variant="success" />
			<StatCard
				label="MiniMax"
				value={Formatter.number(store.summary.minimaxRequests)}
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

	{#if confirmReset}
		<!-- Backdrop -->
		<div
			class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
			role="presentation"
			onclick={() => (confirmReset = false)}
			onkeydown={(e) => e.key === 'Escape' && (confirmReset = false)}>
			<!-- Modal -->
			<div
				class="card preset-tonal-surface border border-surface-700/30 p-6 w-80 space-y-4"
				role="dialog"
				aria-modal="true"
				aria-labelledby="reset-dialog-title"
				tabindex="-1"
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => e.stopPropagation()}>
				<p
					id="reset-dialog-title"
					class="text-sm font-semibold">Reset Analytics?</p>
				<p class="text-sm text-surface-400"
					>This will permanently delete all recorded requests and statistics. This action cannot be undone.</p>
				<div class="flex gap-2 justify-end">
					<button
						class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
						onclick={() => (confirmReset = false)}>
						Cancel
					</button>
					<button
						class="btn btn-sm preset-filled-error-500"
						onclick={handleConfirmReset}>
						<IconTrash2 class="size-4" />
						Reset
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>
