<script lang="ts">
import { formatAge, formatPlanType, formatUsageReset } from './account-format';

import type { AccountUsage, UsageWindow } from '@ungate/shared/frontend';

interface Props {
	usage: AccountUsage;
	/** Clock used to render relative reset/update times. */
	now: number;
}

let { usage, now }: Props = $props();

/** A window whose reset time has passed is shown as reset, not as its stale percentage. */
function effectivePercent(window: UsageWindow): number {
	return window.resetsAt !== null && window.resetsAt <= now ? 0 : window.usedPercent;
}

function barClass(percent: number): string {
	if (percent >= 90) {
		return 'bg-error-500';
	}

	if (percent >= 70) {
		return 'bg-warning-500';
	}

	return 'bg-success-500';
}
</script>

<div class="space-y-1.5">
	{#each usage.windows as window (window.id)}
		{@const percent = effectivePercent(window)}
		{@const reset = formatUsageReset(window.resetsAt, now)}
		<div class="space-y-0.5">
			<div class="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
				<span class="text-surface-200">{window.label}</span>
				<span class="text-surface-400">
					{Math.round(percent)}% used{reset ? ` · ${reset}` : ''}
				</span>
			</div>
			<div
				class="h-1.5 w-full overflow-hidden rounded-full bg-surface-700/50"
				role="progressbar"
				aria-label={`${window.label} usage`}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(percent)}>
				<div
					class="h-full rounded-full transition-[width] {barClass(percent)}"
					style:width={`${percent}%`}>
				</div>
			</div>
		</div>
	{/each}
	<p class="text-xs text-surface-500">
		{#if usage.planType}{formatPlanType(usage.planType)} plan ·
		{/if}{usage.windows.length ? `Updated ${formatAge(usage.updatedAt, now)}` : 'No usage reported yet'}
	</p>
	{#if usage.error}
		<p class="text-xs text-warning-400">Usage refresh failed: {usage.error}</p>
	{/if}
</div>
