<script lang="ts">
import IconBarChart3 from 'virtual:icons/lucide/bar-chart-3';
import IconSettings from 'virtual:icons/lucide/settings';
import IconTerminal from 'virtual:icons/lucide/terminal';

import AnalyticsPage from '$features/analytics/AnalyticsPage.svelte';
import LogsPage from '$features/logs/LogsPage.svelte';
import SettingsPage from '$features/settings/SettingsPage.svelte';

type Page = 'analytics' | 'settings' | 'logs';

let currentPage = $state<Page>('analytics');

const tabs: { id: Page; label: string; icon: typeof IconBarChart3 }[] = [
	{ id: 'analytics', label: 'Analytics', icon: IconBarChart3 },
	{ id: 'settings', label: 'Settings', icon: IconSettings },
	{ id: 'logs', label: 'Logs', icon: IconTerminal }
];
</script>

<div class="min-h-screen bg-surface-950 text-surface-50">
	<header class="border-b border-surface-700/40 bg-surface-900/60 backdrop-blur-sm sticky top-0 z-10">
		<div class="max-w-7xl mx-auto px-4 flex items-center gap-6 h-12">
			<span class="text-sm font-semibold tracking-wide">Ungate</span>

			<nav class="flex gap-1">
				{#each tabs as tab}
					<button
						class="btn btn-sm gap-1.5 {currentPage === tab.id ? 'preset-filled-primary-500' : 'preset-tonal-surface'}"
						onclick={() => (currentPage = tab.id)}>
						<tab.icon class="size-4" />
						{tab.label}
					</button>
				{/each}
			</nav>
		</div>
	</header>

	<main class="max-w-7xl mx-auto px-4 py-6">
		{#if currentPage === 'analytics'}
			<AnalyticsPage />
		{:else if currentPage === 'settings'}
			<SettingsPage />
		{:else if currentPage === 'logs'}
			<LogsPage />
		{/if}
	</main>
</div>
