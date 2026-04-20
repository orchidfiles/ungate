<script lang="ts">
interface Props {
	label: string;
	value: string;
	variant?: 'default' | 'success' | 'warning' | 'error';
}

let { label, value, variant = 'default' }: Props = $props();

const colorClass: Record<string, string> = {
	default: 'text-surface-950-50',
	success: 'text-success-500',
	warning: 'text-warning-500',
	error: 'text-error-500'
};
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 min-h-28 flex flex-col">
	<p class="text-surface-400 text-xs uppercase tracking-wide">{label}</p>
	<p class="mt-auto text-2xl font-semibold {colorClass[variant]}">{value}</p>
</div>
