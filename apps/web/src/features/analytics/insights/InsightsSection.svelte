<script lang="ts">
import StatCard from '../StatCard.svelte';

import AccountsTab from './AccountsTab.svelte';
import AgentsTab from './AgentsTab.svelte';
import { compact, percent } from './insights-format';
import { insightsStore, type InsightsTab } from './insights-store.svelte';
import ReliabilityTab from './ReliabilityTab.svelte';
import TokensTab from './TokensTab.svelte';

const TABS: { value: InsightsTab; label: string }[] = [
	{ value: 'tokens', label: 'Tokens' },
	{ value: 'accounts', label: 'Accounts' },
	{ value: 'agents', label: 'Agents' },
	{ value: 'reliability', label: 'Reliability' }
];

let insights = $derived(insightsStore.insights);
</script>

{#if insightsStore.error}
	<div class="card preset-tonal-error p-4 text-sm">Cannot load usage insights: {insightsStore.error}</div>
{/if}

{#if insights}
	<section class="space-y-4">
		<div class="flex flex-wrap items-end justify-between gap-2">
			<div>
				<p class="text-sm font-semibold">Usage insights</p>
				<p class="text-xs text-surface-400">
					{#if insights.trackingSince}
						Extended telemetry since {new Date(insights.trackingSince).toLocaleString()} ·
						{compact(insights.totals.trackedRequests)} of {compact(insights.totals.requests)} requests tracked in this period. Sessions
						and continuations are inferred heuristically.
					{:else}
						Extended telemetry has not been recorded yet; new requests will fill these charts.
					{/if}
				</p>
			</div>
			<div class="flex gap-1">
				{#each TABS as tab (tab.value)}
					<button
						class="btn btn-sm {insightsStore.tab === tab.value ? 'preset-filled-primary-500' : 'preset-tonal-surface'}"
						onclick={() => (insightsStore.tab = tab.value)}>
						{tab.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
			<StatCard
				label="Cache hit rate"
				value={percent(insights.totals.cacheHitRate)} />
			<StatCard
				label="Avg tokens / session"
				value={compact(insights.totals.avgTokensPerSession)} />
			<StatCard
				label="Continuation rate"
				value={percent(insights.totals.continuationRate)}
				variant={(insights.totals.continuationRate ?? 0) > 0.2 ? 'warning' : 'default'} />
			<StatCard
				label="Pool balance"
				value={percent(insights.totals.poolBalance)}
				variant={insights.totals.poolBalance != null && insights.totals.poolBalance < 0.5 ? 'warning' : 'default'} />
		</div>

		{#if insightsStore.tab === 'tokens'}
			<TokensTab insights={insights} />
		{:else if insightsStore.tab === 'accounts'}
			<AccountsTab insights={insights} />
		{:else if insightsStore.tab === 'agents'}
			<AgentsTab insights={insights} />
		{:else}
			<ReliabilityTab insights={insights} />
		{/if}
	</section>
{/if}
