<script lang="ts">
import { MINIMAX_BASE_URLS } from '@ungate/shared/frontend';
import IconCheck from 'virtual:icons/lucide/check';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconLogOut from 'virtual:icons/lucide/log-out';

import { Api } from '$shared/api';

type UrlType = 'global' | 'china' | 'custom';

interface Props {
	onAuthStatusChange?: () => void;
}

let { onAuthStatusChange }: Props = $props();

let authenticated = $state(false);
let loading = $state(true);
let apiKey = $state('');
let urlType = $state<UrlType>('global');
let customUrl = $state('');
let error = $state<string | null>(null);
let saving = $state(false);
let savingBaseUrl = $state(false);

$effect(() => {
	void loadStatus();
});

function detectUrlType(baseUrl: string): UrlType {
	if (baseUrl === MINIMAX_BASE_URLS.global) return 'global';
	if (baseUrl === MINIMAX_BASE_URLS.china) return 'china';

	return 'custom';
}

function urlTypeToUrl(type: UrlType, custom: string): string {
	if (type === 'global') return MINIMAX_BASE_URLS.global;
	if (type === 'china') return MINIMAX_BASE_URLS.china;

	return custom || MINIMAX_BASE_URLS.global;
}

async function loadStatus() {
	loading = true;
	error = null;

	try {
		const status = await Api.authMinimaxStatus();
		const baseUrl = status.baseUrl ?? MINIMAX_BASE_URLS.global;
		authenticated = status.authenticated;
		urlType = detectUrlType(baseUrl);
		if (urlType === 'custom') customUrl = baseUrl;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	loading = false;
}

async function handleSave() {
	error = null;
	saving = true;

	try {
		const result = await Api.authMinimaxLogin(apiKey.trim(), urlTypeToUrl(urlType, customUrl));

		if (!result.ok) {
			error = result.error ?? 'Failed to save API key';
			saving = false;

			return;
		}

		authenticated = true;
		apiKey = '';
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	saving = false;
}

async function saveBaseUrlImmediately(): Promise<void> {
	if (!authenticated) {
		return;
	}

	const resolvedBaseUrl = urlTypeToUrl(urlType, customUrl).trim();

	if (!resolvedBaseUrl) {
		error = 'Base URL is required';

		return;
	}

	error = null;
	savingBaseUrl = true;

	try {
		const result = await Api.authMinimaxUpdateBaseUrl(resolvedBaseUrl);

		if (!result.ok) {
			error = result.error ?? 'Failed to save base URL';

			return;
		}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	} finally {
		savingBaseUrl = false;
	}
}

async function handleLogout() {
	error = null;

	try {
		await Api.authMinimaxLogout();
		authenticated = false;
		apiKey = '';
		urlType = 'global';
		customUrl = '';
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<p class="text-sm font-semibold">MiniMax</p>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-surface-400">
			<IconLoader class="size-4 animate-spin" />
			Checking status...
		</div>
	{:else}
		<div class="space-y-3">
			{#if authenticated}
				<div class="flex items-center gap-2 text-sm">
					<IconCheck class="size-4 text-success-500" />
					<span>API key configured</span>
				</div>
				<div class="flex gap-2">
					<button
						class="btn btn-sm preset-filled-surface-500 border border-surface-500/50 hover:preset-filled-surface-400"
						onclick={handleLogout}>
						<IconLogOut class="size-4" />
						Logout
					</button>
				</div>
			{:else}
				<label class="label">
					<span class="label-text text-xs">API Key</span>
					<input
						class="input text-sm font-mono"
						type="password"
						bind:value={apiKey}
						placeholder="eyJ..." />
				</label>
			{/if}

			<div class="space-y-1">
				<span class="label-text text-xs">Base URL</span>
				<div class="flex gap-4">
					<label class="flex items-center gap-1.5 text-sm cursor-pointer">
						<input
							type="radio"
							bind:group={urlType}
							value="global"
							class="radio"
							onchange={() => void saveBaseUrlImmediately()} />
						Global
					</label>
					<label class="flex items-center gap-1.5 text-sm cursor-pointer">
						<input
							type="radio"
							bind:group={urlType}
							value="china"
							class="radio"
							onchange={() => void saveBaseUrlImmediately()} />
						China
					</label>
					<label class="flex items-center gap-1.5 text-sm cursor-pointer">
						<input
							type="radio"
							bind:group={urlType}
							value="custom"
							class="radio"
							onchange={() => void saveBaseUrlImmediately()} />
						Custom
					</label>
				</div>
			</div>

			{#if urlType === 'custom'}
				<input
					class="input text-sm"
					type="text"
					bind:value={customUrl}
					onblur={() => void saveBaseUrlImmediately()}
					placeholder="https://your-custom-url.com" />
			{/if}

			{#if authenticated && savingBaseUrl}
				<p class="text-xs text-surface-400">Saving base URL...</p>
			{/if}

			{#if !authenticated}
				<div class="flex gap-2">
					<button
						class="btn btn-sm preset-filled-primary-500"
						onclick={handleSave}
						disabled={saving || !apiKey.trim()}>
						{#if saving}
							<IconLoader class="size-4 animate-spin" />
							Saving...
						{:else}
							Save
						{/if}
					</button>
				</div>
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="card preset-tonal-error p-3 text-sm">
			{error}
		</div>
	{/if}
</div>
