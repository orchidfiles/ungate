<script lang="ts">
import { NgrokAuthToken, sleep, type TunnelProvider } from '@ungate/shared/frontend';
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
let tokenDraft = $state('');

const ngrok = $derived(store.provider === 'ngrok');
const tokenInvalid = $derived(tokenDraft.trim().length > 0 && NgrokAuthToken.normalize(tokenDraft) === null);
const hostnameFlagged = $derived(store.tunnel.warning === 'offensive-hostname');

function handleCopy() {
	if (!store.tunnel.url) return;

	void navigator.clipboard.writeText(`${store.tunnel.url}/v1`).then(async () => {
		copied = true;
		await sleep(2000);
		copied = false;
	});
}

function handleKeyFixChange(event: Event): void {
	const target = event.currentTarget as HTMLInputElement;
	store.setKeyFixEnabled(target.checked);
}

function handleAutoTunnelChange(event: Event): void {
	const target = event.currentTarget as HTMLInputElement;
	store.setAutoTunnelEnabled(target.checked);
}

function handleProviderChange(event: Event): void {
	const target = event.currentTarget as HTMLSelectElement;
	store.setProvider(target.value as TunnelProvider);
}

function switchToQuickTunnel(): void {
	store.setProvider('quick');
	store.restartTunnel();
}

function saveToken(): void {
	const token = NgrokAuthToken.normalize(tokenDraft);

	if (!token) {
		return;
	}

	store.setNgrokAuthToken(token);
	tokenDraft = '';
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<div class="flex items-center justify-between">
		<p class="text-sm font-semibold">{ngrok ? 'Stable tunnel' : 'Cloudflare Tunnel'}</p>
		<div class="flex items-center gap-2">
			<span class="size-2 rounded-full {statusDotClass[store.tunnel.status] ?? 'bg-surface-400'}"></span>
			<span class="text-xs text-surface-400">{statusLabel[store.tunnel.status] ?? store.tunnel.status}</span>
		</div>
	</div>

	{#if store.tunnel.status === 'running' && hostnameFlagged}
		<div class="card preset-tonal-warning p-3 space-y-2">
			<p class="text-sm">
				The tunnel is running, but the address ngrok assigned to your account contains a word Ungate's filter rejects, so it is
				hidden. ngrok picks that name and does not let a free account change it. Requests to that address still reach Ungate; it
				is listed under Domains in the ngrok dashboard.
			</p>
			<p class="text-xs opacity-80">Switch to the Quick tunnel for a different address.</p>
			<button
				class="btn btn-sm preset-filled-primary-500"
				onclick={switchToQuickTunnel}>
				Switch to Quick tunnel
			</button>
		</div>
	{/if}

	{#if store.tunnel.status === 'running' && store.tunnel.url && !hostnameFlagged}
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
				{#if ngrok}
					<p class="text-surface-500">This URL stays the same across restarts.</p>
				{:else}
					<p class="text-surface-500">The URL changes on each restart.</p>
				{/if}
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

	<div class="card preset-tonal-surface border border-surface-700/30 p-3 space-y-2">
		<label class="flex items-center justify-between gap-3">
			<span class="text-sm leading-5">Tunnel</span>
			<select
				class="select text-sm"
				value={store.provider}
				onchange={handleProviderChange}>
				<option value="quick">Quick (rotating URL)</option>
				<option value="ngrok">ngrok (stable URL)</option>
			</select>
		</label>
		{#if ngrok}
			<p class="text-xs text-surface-400">
				Free plan: one dev domain, 1 GB per month, and no uptime guarantee. The authtoken comes from
				<a
					class="anchor"
					href="https://dashboard.ngrok.com/get-started/your-authtoken">dashboard.ngrok.com</a
				>.
			</p>
			<div class="flex items-center gap-2">
				<input
					class="input text-sm flex-1"
					type="password"
					placeholder={store.tokenSet ? 'Authtoken saved' : 'Paste ngrok authtoken'}
					autocomplete="off"
					bind:value={tokenDraft} />
				<button
					class="btn btn-sm preset-tonal-surface"
					disabled={!tokenDraft.trim() || tokenInvalid}
					onclick={saveToken}>
					Save
				</button>
			</div>
			{#if tokenInvalid}
				<p class="text-xs text-error-500">
					That is not an ngrok authtoken. Copy the authtoken from dashboard.ngrok.com; a tunnel URL does not go here.
				</p>
			{/if}
		{:else}
			<p class="text-xs text-surface-400">Nothing to configure. The public URL is new every time the tunnel starts.</p>
		{/if}
	</div>

	<div class="card preset-tonal-surface border border-surface-700/30 p-3 space-y-2">
		<label class="flex items-start gap-3 cursor-pointer">
			<input
				class="checkbox mt-0.5"
				type="checkbox"
				checked={store.autoTunnelEnabled}
				onchange={handleAutoTunnelChange} />
			<span class="text-sm leading-5">Start tunnel automatically and set up Cursor</span>
		</label>
		<p class="text-xs text-surface-400">
			Ungate starts the tunnel as soon as the API is up and turns on OpenAI API Key in Cursor. Cursor does not let extensions
			change the base URL, so whenever the tunnel URL changes Ungate copies it and offers to open Cursor Settings → Models so you
			can paste it.
		</p>
	</div>

	<div class="card preset-tonal-surface border border-surface-700/30 p-3 space-y-2">
		<label class="flex items-start gap-3 cursor-pointer">
			<input
				class="checkbox mt-0.5"
				type="checkbox"
				checked={store.keyFixEnabled}
				onchange={handleKeyFixChange} />
			<span class="text-sm leading-5">Keep OpenAI API Key enabled in Cursor</span>
		</label>
		<p class="text-xs text-surface-400">
			If Cursor turns off OpenAI API Key on its own, Ungate will turn it back on automatically. When you turn this off, Ungate
			stops watching this setting and also turns OpenAI API Key off in Cursor.
		</p>
	</div>
</div>
