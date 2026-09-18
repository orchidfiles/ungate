<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconLogOut from 'virtual:icons/lucide/log-out';

import { Api } from '$shared/api';

interface Props {
	onAuthStatusChange?: () => void;
}

let { onAuthStatusChange }: Props = $props();

let authenticated = $state(false);
let loading = $state(true);
let saving = $state(false);
let apiKey = $state('');
let region = $state('us-east-1');
let error = $state<string | null>(null);

$effect(() => {
	void loadStatus();
});

async function loadStatus() {
	loading = true;
	error = null;

	try {
		const status = await Api.authBedrockStatus();
		authenticated = status.authenticated;
		region = status.region;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	loading = false;
}

async function handleSave() {
	saving = true;
	error = null;

	try {
		const result = await Api.authBedrockLogin(apiKey.trim(), region.trim());

		if (!result.ok) {
			error = result.error ?? 'Failed to save Bedrock API key';

			return;
		}

		authenticated = true;
		apiKey = '';
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		saving = false;
	}
}

async function handleLogout() {
	error = null;

	try {
		await Api.authBedrockLogout();
		authenticated = false;
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<div class="space-y-1">
		<p class="text-sm font-semibold">Amazon Bedrock</p>
		<p class="text-xs text-surface-400">Uses the Bedrock Runtime Responses API with an ABSK bearer key.</p>
	</div>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-surface-400">
			<IconLoader class="size-4 animate-spin" />
			Checking status...
		</div>
	{:else if authenticated}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm">
				<IconCheck class="size-4 text-success-500" />
				<span>Bedrock API key configured in {region}</span>
			</div>
			<button
				class="btn btn-sm preset-filled-surface-500 border border-surface-500/50 hover:preset-filled-surface-400"
				onclick={handleLogout}>
				<IconLogOut class="size-4" />
				Logout
			</button>
		</div>
	{:else}
		<div class="space-y-3">
			<label class="label">
				<span class="label-text text-xs">Bedrock API Key</span>
				<input
					class="input text-sm font-mono"
					type="password"
					bind:value={apiKey}
					placeholder="ABSK..." />
			</label>
			<label class="label">
				<span class="label-text text-xs">AWS Region</span>
				<input
					class="input text-sm"
					type="text"
					bind:value={region}
					placeholder="us-east-1" />
			</label>
			<button
				class="btn btn-sm preset-filled-primary-500"
				onclick={handleSave}
				disabled={saving || !apiKey.trim() || !region.trim()}>
				{#if saving}
					<IconLoader class="size-4 animate-spin" />
					Saving...
				{:else}
					Save
				{/if}
			</button>
		</div>
	{/if}

	{#if error}
		<div class="card preset-tonal-error p-3 text-sm">{error}</div>
	{/if}
</div>
