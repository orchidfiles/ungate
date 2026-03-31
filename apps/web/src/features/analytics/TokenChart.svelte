<script lang="ts">
import { defaultChartPadding, LineChart } from 'layerchart';

import { Formatter } from '$shared/formatter';

import type { RequestRecord } from '@ungate/shared/frontend';

interface Props {
	requests: RequestRecord[];
}

let { requests }: Props = $props();

interface HourlyBucket {
	time: string;
	input: number;
	output: number;
}

let chartData = $derived.by(() => {
	const buckets: Record<string, { input: number; output: number }> = {};

	for (const req of requests) {
		const time = Formatter.time(req.timestamp);

		if (!buckets[time]) {
			buckets[time] = { input: 0, output: 0 };
		}

		buckets[time].input += req.inputTokens;
		buckets[time].output += req.outputTokens;
	}

	const entries: HourlyBucket[] = Object.entries(buckets)
		.slice(-12)
		.map(([time, data]) => ({ time, input: data.input, output: data.output }));

	return entries;
});
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5">
	<p class="text-sm font-semibold mb-4">Token Usage Over Time</p>
	{#if chartData.length > 0}
		<div class="h-60">
			<LineChart
				data={chartData}
				x="time"
				y={['input', 'output']}
				padding={defaultChartPadding({ right: 10 })}
				height={240} />
		</div>
	{:else}
		<p class="text-surface-400 text-sm text-center py-10">No data</p>
	{/if}
</div>
