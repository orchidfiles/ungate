<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
	title: string;
	note?: string;
	empty?: boolean;
	emptyText?: string;
	class?: string;
	children: Snippet;
}

let { title, note, empty = false, emptyText = 'Not tracked yet', class: className = '', children }: Props = $props();
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 {className}">
	<div class="mb-3 flex items-baseline justify-between gap-3">
		<p class="text-sm font-semibold">{title}</p>
		{#if note}
			<p class="text-xs text-surface-400 text-right">{note}</p>
		{/if}
	</div>
	{#if empty}
		<p class="text-surface-400 text-sm text-center py-10">{emptyText}</p>
	{:else}
		{@render children()}
	{/if}
</div>
