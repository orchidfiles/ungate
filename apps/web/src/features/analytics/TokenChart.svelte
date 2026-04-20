<script lang="ts">
import { defaultChartPadding, LineChart } from 'layerchart';
import { SvelteMap } from 'svelte/reactivity';

import type { Period, TokenSeriesPoint } from '@ungate/shared/frontend';

interface Props {
	series: TokenSeriesPoint[];
	period: Period;
}

let { series, period }: Props = $props();

interface HourlyBucket {
	time: string;
	input: number;
	output: number;
}

let chartData = $derived.by(() => {
	if (period === 'day') {
		return buildDaySeries(series);
	}

	let entryLimit = 31;

	if (period === 'hour') {
		entryLimit = 12;
	}

	const entries: HourlyBucket[] = series.slice(-entryLimit).map((point) => ({
		time: formatBucketLabel(point.bucket, period),
		input: point.inputTokens,
		output: point.outputTokens
	}));

	return entries;
});

function buildDaySeries(points: TokenSeriesPoint[]): HourlyBucket[] {
	if (points.length === 0) {
		return [];
	}

	const byHour = new SvelteMap<string, { input: number; output: number }>();

	for (const point of points) {
		byHour.set(point.bucket, { input: point.inputTokens, output: point.outputTokens });
	}

	const lastBucket = points[points.length - 1]?.bucket;

	if (!lastBucket) {
		return [];
	}

	const lastHour = parseHourBucket(lastBucket);
	const alignedEnd = createDate(lastHour);
	alignedEnd.setUTCHours(Math.floor(alignedEnd.getUTCHours() / 2) * 2, 0, 0, 0);

	const entries: HourlyBucket[] = [];

	for (let index = 0; index < 12; index += 1) {
		const bucketDate = createDate(alignedEnd);
		bucketDate.setUTCHours(alignedEnd.getUTCHours() - (11 - index) * 2, 0, 0, 0);

		const leftKey = formatHourBucket(bucketDate);
		const rightDate = createDate(bucketDate);
		rightDate.setUTCHours(bucketDate.getUTCHours() + 1, 0, 0, 0);
		const rightKey = formatHourBucket(rightDate);
		const left = byHour.get(leftKey);
		const right = byHour.get(rightKey);

		entries.push({
			time: `${pad2(bucketDate.getUTCHours())}:00`,
			input: (left?.input ?? 0) + (right?.input ?? 0),
			output: (left?.output ?? 0) + (right?.output ?? 0)
		});
	}

	return entries;
}

function createDate(value: string | number | Date): Date {
	return new Date(value);
}

function parseHourBucket(bucket: string): Date {
	return createDate(`${bucket.replace(' ', 'T')}:00Z`);
}

function formatHourBucket(date: Date): string {
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:00`;
}

function formatBucketLabel(bucket: string, selectedPeriod: Period): string {
	if (selectedPeriod === 'month' || selectedPeriod === 'week' || selectedPeriod === 'all') {
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket);
		if (match) {
			const [, , month, day] = match;

			return `${month}-${day}`;
		}
	}

	return bucket;
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5">
	<p class="text-sm font-semibold mb-4">Token Usage Over Time</p>
	{#if chartData.length > 0}
		<div class="h-60">
			<LineChart
				data={chartData}
				x="time"
				y={['input', 'output']}
				padding={defaultChartPadding({ top: 10, right: 10, bottom: 30, left: 64 })}
				height={240} />
		</div>
	{:else}
		<p class="text-surface-400 text-sm text-center py-10">No data</p>
	{/if}
</div>
