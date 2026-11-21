<script lang="ts">
import { BarChart, defaultChartPadding } from 'layerchart';

import ChartCard from './ChartCard.svelte';
import { bucketLabel, percent, pivot, SERIES_COLORS, seriesFor } from './insights-format';

import type { UsageInsights } from '@ungate/shared/frontend';

interface Props {
	insights: UsageInsights;
}

let { insights }: Props = $props();

const padding = defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 64 });

const CAUSE_LABELS: Record<string, string> = {
	max_tokens: 'Truncated (max tokens)',
	error: 'After upstream error',
	aborted: 'After cancel',
	nudge: 'User "continue" nudge'
};

let rotation = $derived(insights.rotation.series.map((point) => ({ ...point, bucket: bucketLabel(point.bucket) })));
let hasRotation = $derived(rotation.some((point) => point.rotated > 0 || point.errors > 0));
let causes = $derived(
	pivot(
		insights.continuations.series,
		(point) => point.cause,
		(point) => point.count
	)
);
let errorTypes = $derived([...insights.rotation.errorsByType].reverse());
let reasons = $derived([...insights.rotation.byReason].reverse());
</script>

<div class="grid gap-4 lg:grid-cols-2">
	<ChartCard
		title="Rotations and errors over time"
		note="Rotated = served after another account hit its limit"
		empty={!hasRotation}
		emptyText="No rotations or errors"
		class="lg:col-span-2">
		<div class="h-60">
			<BarChart
				data={rotation}
				x="bucket"
				series={[
					{ key: 'rotated', label: 'Rotated', color: SERIES_COLORS[4] },
					{ key: 'errors', label: 'Errors', color: SERIES_COLORS[5] }
				]}
				seriesLayout="stack"
				legend
				padding={padding}
				height={240} />
		</div>
	</ChartCard>

	<ChartCard
		title="Continuations by cause"
		note={`${insights.continuations.total} continuations · ${percent(insights.totals.continuationRate)} of sessions`}
		empty={causes.rows.length === 0}
		emptyText="No continued work detected">
		<div class="h-56">
			<BarChart
				data={causes.rows}
				x="bucket"
				series={seriesFor(causes.keys, (key) => CAUSE_LABELS[key] ?? key)}
				seriesLayout="stack"
				legend
				padding={padding}
				height={224} />
		</div>
	</ChartCard>

	<ChartCard
		title="Rotation reasons"
		empty={reasons.length === 0}
		emptyText="No account rotations">
		<div class="h-56">
			<BarChart
				data={reasons}
				y="key"
				x="count"
				orientation="horizontal"
				series={[{ key: 'count', label: 'Rotations', color: SERIES_COLORS[4] }]}
				padding={defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 110 })}
				height={224} />
		</div>
	</ChartCard>

	<ChartCard
		title="Errors by type"
		empty={errorTypes.length === 0}
		emptyText="No errors"
		class="lg:col-span-2">
		<div class="h-64">
			<BarChart
				data={errorTypes}
				y="key"
				x="count"
				orientation="horizontal"
				series={[{ key: 'count', label: 'Errors', color: SERIES_COLORS[5] }]}
				padding={defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 260 })}
				height={256} />
		</div>
	</ChartCard>
</div>
