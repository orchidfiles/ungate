<script lang="ts">
import IconCopy from 'virtual:icons/lucide/copy';
import IconPlay from 'virtual:icons/lucide/play';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';
import IconSquare from 'virtual:icons/lucide/square';

import { getTunnelStore } from './tunnel-store.svelte';

const store = getTunnelStore();

const statusLabel: Record<string, string> = {
	stopped: 'Stopped',
	installing: 'Downloading cloudflared...',
	starting: 'Starting...',
	running: 'Running',
	error: 'Error'
};

const statusDotClass: Record<string, string> = {
	stopped: 'bg-surface-400',
	installing: 'bg-warning-500 animate-pulse',
	starting: 'bg-warning-500 animate-pulse',
	running: 'bg-success-500',
	error: 'bg-error-500'
};

let copied = $state(false);

function handleCopy() {
	if (!store.tunnel.url) return;

	void navigator.clipboard.writeText(`${store.tunnel.url}/v1`).then(() => {
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	});
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<div class="flex items-center justify-between">
		<p class="text-sm font-semibold">Cloudflare Tunnel</p>
		<div class="flex items-center gap-2">
			<span class="size-2 rounded-full {statusDotClass[store.tunnel.status] ?? 'bg-surface-400'}"></span>
			<span class="text-xs text-surface-400">{statusLabel[store.tunnel.status] ?? store.tunnel.status}</span>
		</div>
	</div>

	{#if store.tunnel.status === 'running' && store.tunnel.url}
		<div class="space-y-2">
			<div class="flex items-center gap-2">
				<code class="code text-surface-950-50 text-xs flex-1 truncate">{store.tunnel.url}/v1</code>
				<button
					class="btn btn-sm preset-tonal-surface"
					onclick={handleCopy}
					title="Copy URL">
					<IconCopy class="size-4" />
					{copied ? 'Copied!' : 'Copy'}
				</button>
			</div>
			<div class="text-xs text-surface-400 space-y-1">
				<p>Paste this URL into Cursor Settings → Models → OpenAI API Base URL.</p>
				<p>In the API Key field paste the key from Server Configuration below (or leave empty if no key is set).</p>
				<p class="text-surface-500">The URL changes on each restart.</p>
			</div>
		</div>
	{/if}

	{#if store.tunnel.status === 'error' && store.tunnel.error}
		<div class="card preset-tonal-error p-3">
			<p class="text-sm opacity-70">{store.tunnel.error}</p>
		</div>
	{/if}

	<div class="flex gap-2">
		{#if store.tunnel.status === 'stopped' || store.tunnel.status === 'error'}
			<button
				class="btn btn-sm preset-filled-primary-500"
				onclick={() => store.startTunnel()}>
				<IconPlay class="size-4" />
				Start tunnel
			</button>
		{:else if store.tunnel.status === 'running'}
			<button
				class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
				onclick={() => store.restartTunnel()}>
				<IconRotateCcw class="size-4" />
				Restart
			</button>
			<button
				class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
				onclick={() => store.stopTunnel()}>
				<IconSquare class="size-4" />
				Stop
			</button>
		{:else}
			<button
				class="btn btn-sm preset-tonal-surface"
				disabled>
				<IconRotateCcw class="size-4 animate-spin" />
				{statusLabel[store.tunnel.status] ?? 'Working...'}
			</button>
			<button
				class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
				onclick={() => store.stopTunnel()}>
				<IconSquare class="size-4" />
				Stop
			</button>
		{/if}
	</div>
</div>
