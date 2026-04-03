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

<div class="card preset-tonal-surface border border-surface-700/30 p-5">
	<p class="text-surface-400 text-xs uppercase tracking-wide mb-2">{label}</p>
	<p class="text-2xl font-semibold {colorClass[variant]}">{value}</p>
</div>
