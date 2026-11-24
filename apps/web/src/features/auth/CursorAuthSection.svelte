<script lang="ts">
import { type CursorSessionStatus, type ExtensionToWebview, sleep } from '@ungate/shared/frontend';
import IconCheck from 'virtual:icons/lucide/check';
import IconDownload from 'virtual:icons/lucide/download';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconPlug from 'virtual:icons/lucide/plug';
import IconRefresh from 'virtual:icons/lucide/refresh-cw';
import IconUnplug from 'virtual:icons/lucide/unplug';

import { Api, type CursorModelListItem, errorMessage } from '$shared/api';
import { postExtensionMessage } from '$shared/vscode';

import { getSettingsStore } from '../settings/settings-store.svelte';

interface Props {
	onAuthStatusChange?: () => void;
}

let { onAuthStatusChange }: Props = $props();

const settingsStore = getSettingsStore();

let status = $state<CursorSessionStatus | null>(null);
let enabled = $state<boolean | null>(null);
let loading = $state(true);
let toggling = $state(false);
let models = $state<CursorModelListItem[]>([]);
let modelsLoading = $state(false);
let importing = $state<string | null>(null);
let error = $state<string | null>(null);

const reasonText: Record<CursorSessionStatus['reason'], string> = {
	ok: 'Session connected — inference blocked',
	disabled: 'Not connected',
	no_bridge: 'Unavailable: the API was not started by this Cursor window',
	no_cursor_api: 'Unavailable: this editor does not expose a Cursor session',
	not_signed_in: 'Not signed in to Cursor — inference remains blocked',
	token_encrypted: 'Unavailable: this Cursor version encrypts its session token, which Ungate cannot read',
	error: 'Could not read the Cursor session'
};

async function loadStatus(): Promise<void> {
	try {
		status = await Api.cursorStatus();
		error = null;
	} catch (e) {
		error = errorMessage(e);
	}

	loading = false;
}

async function loadModels(): Promise<void> {
	modelsLoading = true;

	try {
		const result = await Api.cursorModels();
		models = result.models;
		error = result.error ? result.error.message : null;
	} catch (e) {
		error = errorMessage(e);
	}

	modelsLoading = false;
}

async function setEnabled(next: boolean): Promise<void> {
	toggling = true;
	error = null;
	postExtensionMessage({ type: 'set-cursor-provider-enabled', enabled: next });

	// The extension flips the flag asynchronously; poll briefly until the bridge reports it.
	for (let attempt = 0; attempt < 10; attempt++) {
		await sleep(300);
		await loadStatus();
		if (status && status.reason !== (next ? 'disabled' : 'ok')) break;
	}

	toggling = false;
	onAuthStatusChange?.();
	if (next && status?.connected) await loadModels();
	if (!next) models = [];
}

async function importModel(model: CursorModelListItem): Promise<void> {
	importing = model.id;
	error = null;

	try {
		await Api.cursorImportModel({ upstreamModel: model.id, label: model.displayName || model.id });
		models = models.map((item) => (item.id === model.id ? { ...item, imported: true } : item));
		await settingsStore.load();
	} catch (e) {
		error = errorMessage(e);
	}

	importing = null;
}

function handleMessage(event: MessageEvent): void {
	const message = event.data as ExtensionToWebview;

	if (message.type === 'cursor-provider-state') {
		enabled = message.enabled;
	}
}

$effect(() => {
	window.addEventListener('message', handleMessage);
	void loadStatus().then(() => {
		if (status?.connected) void loadModels();
	});

	return () => window.removeEventListener('message', handleMessage);
});

const connected = $derived(status?.connected === true);
const optedIn = $derived(enabled ?? (status ? status.reason !== 'disabled' : false));
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<div class="flex items-center gap-2">
		<p class="text-sm font-semibold">Cursor</p>
		<span class="badge text-[10px] preset-tonal-warning uppercase tracking-wide">Inference blocked</span>
	</div>

	<p class="text-xs text-surface-400">
		Cursor inference is blocked because subscription-only billing cannot be guaranteed. Signing in, connecting a session,
		discovering models, or importing a model mapping does not grant permission to run inference or prove included plan usage.
		Billing for historical Cursor requests is unknown, not free. The session token stays inside the extension.
	</p>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-surface-400">
			<IconLoader class="size-4 animate-spin" />
			Checking status...
		</div>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2 text-sm">
				{#if connected}
					<IconCheck class="size-4 text-success-500" />
				{/if}
				<span>{status ? reasonText[status.reason] : 'Unknown'}</span>
				{#if connected && status?.membershipType}
					<span class="badge text-[10px] preset-tonal-surface">{status.membershipType}</span>
				{/if}
			</div>

			<div class="flex gap-2">
				{#if optedIn}
					<button
						class="btn btn-sm preset-filled-surface-500 border border-surface-500/50 hover:preset-filled-surface-400"
						disabled={toggling}
						onclick={() => void setEnabled(false)}>
						<IconUnplug class="size-4" />
						Disconnect
					</button>
				{:else}
					<button
						class="btn btn-sm preset-filled-primary-500"
						disabled={toggling || status?.reason === 'no_bridge' || status?.reason === 'no_cursor_api'}
						onclick={() => void setEnabled(true)}>
						{#if toggling}
							<IconLoader class="size-4 animate-spin" />
						{:else}
							<IconPlug class="size-4" />
						{/if}
						Connect for discovery
					</button>
				{/if}
			</div>
		</div>

		{#if status?.reason === 'token_encrypted'}
			<div
				class="card preset-tonal-warning p-3 text-sm"
				role="status">
				This Cursor session is encrypted and no usable session API is available to Ungate. Retrying, signing in again, or
				restarting the tunnel will not make this session readable. Use another configured provider in Ungate or Cursor’s native
				models instead. Do not disable encryption or copy session tokens into Ungate.
			</div>
		{/if}

		{#if connected}
			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<p class="text-xs font-medium text-surface-300">Discovered models — inference blocked</p>
					<button
						class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
						disabled={modelsLoading}
						onclick={() => void loadModels()}>
						<IconRefresh class="size-4 {modelsLoading ? 'animate-spin' : ''}" />
						Refresh
					</button>
				</div>

				{#if modelsLoading && models.length === 0}
					<p class="text-xs text-surface-400">Loading models...</p>
				{:else if models.length === 0}
					<p class="text-xs text-surface-400">No models reported by Cursor.</p>
				{:else}
					<ul class="divide-y divide-surface-700/40 rounded border border-surface-700/40">
						{#each models as model (model.id)}
							<li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
								<div class="min-w-0">
									<p class="truncate">{model.displayName || model.id}</p>
									<p class="truncate text-xs font-mono text-surface-400">
										{model.id} · tools {model.toolMode}{model.thinking ? ' · thinking' : ''}
									</p>
								</div>
								{#if model.imported}
									<span class="text-xs text-success-400 flex items-center gap-1"><IconCheck class="size-3.5" />Imported</span>
								{:else}
									<button
										class="btn btn-sm preset-filled-primary-500"
										disabled={importing !== null}
										onclick={() => void importModel(model)}>
										{#if importing === model.id}
											<IconLoader class="size-4 animate-spin" />
										{:else}
											<IconDownload class="size-4" />
										{/if}
										Import
									</button>
								{/if}
							</li>
						{/each}
					</ul>
					<p class="text-xs text-surface-400">
						Imported mappings appear below as <code class="code">cursor-&lt;model&gt;</code> for configuration only. Importing does
						not enable inference; subscription-only billing remains unverified.
					</p>
				{/if}
			</div>
		{/if}
	{/if}

	{#if error}
		<div class="card preset-tonal-error p-3 text-sm">
			{error}
		</div>
	{/if}
</div>
