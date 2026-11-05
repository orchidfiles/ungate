<script lang="ts">
import { getProviderLabel } from '@ungate/shared/frontend';
import { BarChart, defaultChartPadding, PieChart } from 'layerchart';

import { getAccountStore } from '$features/auth/account-store.svelte';

import ChartCard from './ChartCard.svelte';
import { compact, percent, pivot, SERIES_COLORS } from './insights-format';

import type { SubscriptionAccount, UsageInsights } from '@ungate/shared/frontend';

interface Props {
	insights: UsageInsights;
}

let { insights }: Props = $props();

const claudeAccounts = getAccountStore('claude');
const openaiAccounts = getAccountStore('openai');

// Live subscription usage (% of the busiest window) comes from the account stores, not analytics.
$effect(() => {
	const detachClaude = claudeAccounts.attach();
	const detachOpenai = openaiAccounts.attach();

	return () => {
		detachClaude();
		detachOpenai();
	};
});

let liveAccounts = $derived(
	new Map<string, SubscriptionAccount>(
		[...claudeAccounts.accounts, ...openaiAccounts.accounts].map((account) => [account.id, account])
	)
);

let labels = $derived(new Map(insights.accounts.map((account) => [account.accountId, account.label])));
let colors = $derived(
	new Map(insights.accounts.map((account, index) => [account.accountId, SERIES_COLORS[index % SERIES_COLORS.length]]))
);

let series = $derived(
	pivot(
		insights.accountSeries,
		(point) => point.accountId,
		(point) => point.tokens
	)
);

let donut = $derived(
	insights.accounts.map((account) => ({
		key: account.accountId,
		label: account.label,
		value: account.inputTokens + account.outputTokens
	}))
);

function busiestWindow(accountId: string): string {
	const windows = liveAccounts.get(accountId)?.usage?.windows ?? [];
	if (windows.length === 0) return '—';
	const top = windows.reduce((max, window) => (window.usedPercent > max.usedPercent ? window : max));

	return `${Math.round(top.usedPercent)}% ${top.label}`;
}

function balanceText(value: number | null): string {
	if (value == null) return 'Needs 2+ accounts';
	if (value >= 0.8) return 'Well balanced';
	if (value >= 0.5) return 'Somewhat uneven';

	return 'Concentrated on few accounts';
}
</script>

{#if insights.accounts.length === 0}
	<ChartCard
		title="Account pool"
		empty
		emptyText="No requests with account attribution yet. Account tracking starts with this version.">
		<span></span>
	</ChartCard>
{:else}
	<div class="grid gap-4 lg:grid-cols-3">
		<ChartCard
			title="Tokens per account over time"
			class="lg:col-span-2">
			<div class="h-64">
				<BarChart
					data={series.rows}
					x="bucket"
					series={series.keys.map((key) => ({ key, label: labels.get(key) ?? key, color: colors.get(key) }))}
					seriesLayout="stack"
					props={{ yAxis: { format: (value: number) => compact(value) } }}
					legend
					padding={defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 64 })}
					height={256} />
			</div>
		</ChartCard>

		<ChartCard
			title="Share of pool"
			note={`Balance ${percent(insights.totals.poolBalance)} · ${balanceText(insights.totals.poolBalance)}`}>
			<div class="h-64">
				<PieChart
					data={donut}
					key="key"
					label="label"
					value="value"
					cRange={insights.accounts.map((account) => colors.get(account.accountId) ?? SERIES_COLORS[0])}
					innerRadius={-28}
					padAngle={0.02}
					legend
					height={256} />
			</div>
		</ChartCard>

		<ChartCard
			title="Accounts"
			class="lg:col-span-3">
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-xs uppercase text-surface-400">
						<tr class="text-left">
							<th class="py-2 pr-3">Account</th>
							<th class="py-2 pr-3 text-right">Requests</th>
							<th class="py-2 pr-3 text-right">Tokens</th>
							<th class="py-2 pr-3 text-right">Share</th>
							<th class="py-2 pr-3 text-right">Errors</th>
							<th class="py-2 pr-3 text-right">Rotated in</th>
							<th class="py-2 pr-3 text-right">Est. cost</th>
							<th class="py-2 text-right">Current usage</th>
						</tr>
					</thead>
					<tbody>
						{#each insights.accounts as account (account.accountId)}
							<tr class="border-t border-surface-700/30">
								<td class="py-2 pr-3">
									<span
										class="mr-2 inline-block size-2 rounded-full"
										style="background: {colors.get(account.accountId)}"></span>
									{account.label}
									{#if account.provider}
										<span class="text-xs text-surface-400">· {getProviderLabel(account.provider as 'claude' | 'openai')}</span>
									{/if}
								</td>
								<td class="py-2 pr-3 text-right">{compact(account.requests)}</td>
								<td class="py-2 pr-3 text-right">{compact(account.inputTokens + account.outputTokens)}</td>
								<td class="py-2 pr-3 text-right">{percent(account.share)}</td>
								<td class="py-2 pr-3 text-right {account.errors > 0 ? 'text-error-500' : ''}">
									{percent(account.requests > 0 ? account.errors / account.requests : null, 1)}
								</td>
								<td class="py-2 pr-3 text-right">{compact(account.rotatedIn)}</td>
								<td class="py-2 pr-3 text-right">${account.estimatedCost.toFixed(2)}</td>
								<td class="py-2 text-right">{busiestWindow(account.accountId)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</ChartCard>
	</div>
{/if}
