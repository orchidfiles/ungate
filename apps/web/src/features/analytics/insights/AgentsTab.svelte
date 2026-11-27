<script lang="ts">
import { BarChart, defaultChartPadding, ScatterChart } from 'layerchart';

import { formatModelName } from '../analytics-store.svelte';

import ChartCard from './ChartCard.svelte';
import { compact, duration, pivot, SERIES_COLORS, seriesFor } from './insights-format';

import type { UsageInsights } from '@ungate/shared/frontend';

interface Props {
	insights: UsageInsights;
}

let { insights }: Props = $props();

const padding = defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 64 });

const STOP_LABELS: Record<string, string> = {
	end_turn: 'End turn',
	tool_use: 'Tool use',
	max_tokens: 'Max tokens',
	stop_sequence: 'Stop sequence',
	error: 'Error',
	aborted: 'Aborted',
	unknown: 'Unknown'
};

let sessions = $derived(insights.sessions);
let hasSessions = $derived(sessions.top.length > 0);
let stops = $derived(
	pivot(
		insights.stopReasons,
		(point) => point.reason,
		(point) => point.count
	)
);
let tools = $derived([...insights.tools.top].reverse());
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<ChartCard
		title="Turns per session"
		note="Sessions are inferred from the first user message"
		empty={!hasSessions}>
		<div class="h-56">
			<BarChart
				data={sessions.turnsHistogram}
				x="key"
				y="count"
				series={[{ key: 'count', label: 'Sessions', color: SERIES_COLORS[0] }]}
				padding={padding}
				height={224} />
		</div>
	</ChartCard>

	<ChartCard
		title="Context size by turn"
		note={sessions.medianGrowthPerTurn == null
			? undefined
			: `Median growth ${compact(sessions.medianGrowthPerTurn)} input tokens / turn`}
		empty={sessions.contextSamples.length === 0}>
		<div class="h-56">
			<ScatterChart
				data={sessions.contextSamples}
				x="turnIndex"
				y="inputTokens"
				series={[{ key: 'samples', label: 'Request', data: sessions.contextSamples, color: SERIES_COLORS[0] }]}
				props={{
					points: { r: 2, fillOpacity: 0.4 },
					yAxis: { format: (value: number) => compact(value) }
				}}
				padding={padding}
				height={224} />
		</div>
	</ChartCard>

	<ChartCard
		title="Stop reasons over time"
		empty={stops.rows.length === 0}>
		<div class="h-56">
			<BarChart
				data={stops.rows}
				x="bucket"
				series={seriesFor(stops.keys, (key) => STOP_LABELS[key] ?? key)}
				seriesLayout="stack"
				legend
				padding={padding}
				height={224} />
		</div>
	</ChartCard>

	<ChartCard
		title="Top tools"
		note={insights.totals.avgToolCalls == null ? undefined : `${insights.totals.avgToolCalls.toFixed(2)} tool calls / request`}
		empty={tools.length === 0}>
		<div class="h-56">
			<BarChart
				data={tools}
				y="key"
				x="count"
				orientation="horizontal"
				series={[{ key: 'count', label: 'Calls', color: SERIES_COLORS[1] }]}
				padding={defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 110 })}
				height={224} />
		</div>
	</ChartCard>

	<ChartCard
		title="Top sessions by tokens"
		empty={!hasSessions}
		class="lg:col-span-2">
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead class="text-xs uppercase text-surface-400">
					<tr class="text-left">
						<th class="py-2 pr-3">Session</th>
						<th class="py-2 pr-3">Model</th>
						<th class="py-2 pr-3 text-right">Turns</th>
						<th class="py-2 pr-3 text-right">Tokens</th>
						<th class="py-2 pr-3 text-right">Max context</th>
						<th class="py-2 pr-3 text-right">Tool calls</th>
						<th class="py-2 pr-3 text-right">Accounts</th>
						<th class="py-2 pr-3 text-right">Duration</th>
						<th class="py-2 text-right">Continued</th>
					</tr>
				</thead>
				<tbody>
					{#each sessions.top as session (session.sessionKey)}
						<tr class="border-t border-surface-700/30">
							<td
								class="py-2 pr-3 font-mono text-xs"
								title={new Date(session.firstSeen).toLocaleString()}>{session.sessionKey.slice(0, 8)}</td>
							<td class="py-2 pr-3">
								<div>{formatModelName(session.model)}</div>
								{#if session.model && formatModelName(session.model) !== session.model}
									<div class="font-mono text-[10px] text-surface-400">{session.model}</div>
								{/if}
							</td>
							<td class="py-2 pr-3 text-right">{session.turns}</td>
							<td class="py-2 pr-3 text-right">{compact(session.totalTokens)}</td>
							<td class="py-2 pr-3 text-right">{compact(session.maxInputTokens)}</td>
							<td class="py-2 pr-3 text-right">{compact(session.toolCalls)}</td>
							<td class="py-2 pr-3 text-right">{session.accounts}</td>
							<td class="py-2 pr-3 text-right">{duration(session.lastSeen - session.firstSeen)}</td>
							<td class="py-2 text-right">
								{#if session.continuations > 0}
									<span class="badge preset-tonal-warning">{session.continuations}×</span>
								{:else}
									<span class="text-surface-400">—</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</ChartCard>
</div>
