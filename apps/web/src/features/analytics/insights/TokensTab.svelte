<script lang="ts">
import { AreaChart, BarChart, defaultChartPadding, LineChart } from 'layerchart';

import { formatModelName } from '../analytics-store.svelte';

import ChartCard from './ChartCard.svelte';
import { bucketLabel, CHARS_PER_TOKEN, compact, percent, pivot, SERIES_COLORS, seriesFor } from './insights-format';

import type { UsageInsights } from '@ungate/shared/frontend';

interface Props {
	insights: UsageInsights;
}

let { insights }: Props = $props();

const padding = defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 64 });

const MIX_SERIES = [
	{ key: 'uncachedInput', label: 'Uncached input', color: SERIES_COLORS[0] },
	{ key: 'cacheRead', label: 'Cache read', color: SERIES_COLORS[3] },
	{ key: 'cacheWrite', label: 'Cache write', color: SERIES_COLORS[4] },
	{ key: 'untrackedInput', label: 'Input (no cache split)', color: SERIES_COLORS[6] },
	{ key: 'output', label: 'Output', color: SERIES_COLORS[1] },
	{ key: 'reasoning', label: 'Reasoning', color: SERIES_COLORS[2] }
];

let mix = $derived(insights.tokenMix.map((point) => ({ ...point, bucket: bucketLabel(point.bucket) })));
let hasMix = $derived(mix.some((point) => point.requests > 0));

let hit = $derived(
	pivot(
		insights.cacheHitRate,
		(point) => point.model,
		(point) => point.hitRate,
		null
	)
);

let reasoning = $derived(
	insights.models
		.filter((model) => model.outputTokens > 0)
		.slice(0, 10)
		.map((model) => {
			const estimated = model.reasoningTokens === 0 && model.reasoningChars > 0;
			const reasoningTokens = estimated ? Math.round(model.reasoningChars / CHARS_PER_TOKEN) : model.reasoningTokens;

			return {
				name: `${formatModelName(model.model)}${model.reasoningTier ? ` · ${model.reasoningTier}` : ''}${estimated ? ' (est.)' : ''}`,
				// Both providers count reasoning inside output_tokens.
				visible: Math.max(model.outputTokens - reasoningTokens, 0),
				reasoning: reasoningTokens
			};
		})
);
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<ChartCard
		title="Token mix over time"
		note="Grey input predates cache tracking or had no cache split"
		empty={!hasMix}
		emptyText="No data"
		class="lg:col-span-2">
		<div class="h-64">
			<AreaChart
				data={mix}
				x="bucket"
				series={MIX_SERIES}
				seriesLayout="stack"
				props={{ yAxis: { format: (value: number) => compact(value) } }}
				legend
				padding={padding}
				height={256} />
		</div>
	</ChartCard>

	<ChartCard
		title="Cache hit rate by model"
		note="cache read ÷ total input"
		empty={hit.rows.length === 0}>
		<div class="h-56">
			<LineChart
				data={hit.rows}
				x="bucket"
				series={seriesFor(hit.keys, formatModelName)}
				yDomain={[0, 1]}
				props={{ yAxis: { format: (value: number) => percent(value) } }}
				legend
				padding={padding}
				height={224} />
		</div>
	</ChartCard>

	<ChartCard
		title="Reasoning vs visible output"
		note="(est.) = thinking characters ÷ {CHARS_PER_TOKEN}, counted inside output"
		empty={reasoning.length === 0}>
		<div class="h-56">
			<BarChart
				data={reasoning}
				y="name"
				orientation="horizontal"
				series={[
					{ key: 'visible', label: 'Visible output', color: SERIES_COLORS[1] },
					{ key: 'reasoning', label: 'Reasoning', color: SERIES_COLORS[2] }
				]}
				seriesLayout="stack"
				props={{ xAxis: { format: (value: number) => compact(value) } }}
				legend
				padding={defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 150 })}
				height={224} />
		</div>
	</ChartCard>
</div>
