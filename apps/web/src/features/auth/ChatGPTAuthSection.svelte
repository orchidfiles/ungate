<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconLogOut from 'virtual:icons/lucide/log-out';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';

import { Api } from '$shared/api';
import { postExtensionMessage } from '$shared/vscode';

interface Props {
	onAuthStatusChange?: () => void;
}

let { onAuthStatusChange }: Props = $props();

let authenticated = $state(false);
let email = $state<string | undefined>(undefined);
let loading = $state(true);
let checking = $state(false);
let error = $state<string | null>(null);
let pollingTimer = $state<ReturnType<typeof setInterval> | null>(null);
let timeoutTimer = $state<ReturnType<typeof setTimeout> | null>(null);
let lastAction = $state('');
let cancelled = $state(false);

function stopPolling() {
	if (pollingTimer) {
		clearInterval(pollingTimer);
		pollingTimer = null;
	}

	if (timeoutTimer) {
		clearTimeout(timeoutTimer);
		timeoutTimer = null;
	}
}

$effect(() => {
	void loadStatus();
});

async function loadStatus() {
	loading = true;
	error = null;

	try {
		const status = await Api.authChatGPTStatus();
		authenticated = status.authenticated;
		email = status.email;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	loading = false;
}

async function handleLogin() {
	error = null;
	checking = true;
	cancelled = false;
	lastAction = 'Authorization started';
	stopPolling();

	try {
		const result = await Api.authChatGPTStart();
		postExtensionMessage({ type: 'open-external-url', url: result.authUrl });
		lastAction = 'Waiting for OpenAI callback';
		pollingTimer = setInterval(() => {
			void (async () => {
				try {
					const status = await Api.authChatGPTStatus();
					if (status.authenticated) {
						stopPolling();
						authenticated = true;
						email = status.email;
						checking = false;
						lastAction = 'Authorization completed';
						onAuthStatusChange?.();
					}
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
					lastAction = 'Status check failed';
				}
			})();
		}, 1000);

		timeoutTimer = setTimeout(() => {
			stopPolling();
			if (checking) {
				checking = false;
				error = 'Authorization timed out';
				lastAction = 'Authorization timed out';
			}
		}, 300_000);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		checking = false;
		lastAction = 'Failed to start authorization';
		stopPolling();
	}
}

function handleCancel() {
	stopPolling();
	checking = false;
	cancelled = true;
	error = null;
	lastAction = 'Authorization cancelled by user';
}

function handleRetry() {
	cancelled = false;
	error = null;
	void handleLogin();
}

async function handleLogout() {
	error = null;

	try {
		await Api.authChatGPTLogout();
		authenticated = false;
		email = undefined;
		cancelled = false;
		lastAction = 'Disconnected';
		stopPolling();
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		lastAction = 'Failed to disconnect';
	}
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<p class="text-sm font-semibold">ChatGPT</p>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-surface-400">
			<IconLoader class="size-4 animate-spin" />
			Checking status...
		</div>
	{:else if authenticated}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm">
				<IconCheck class="size-4 text-success-500" />
				<span>Connected{email ? ` as ${email}` : ''}</span>
			</div>
			<button
				class="btn btn-sm preset-filled-surface-500 border border-surface-500/50 hover:preset-filled-surface-400 w-fit"
				onclick={handleLogout}>
				<IconLogOut class="size-4" />
				Disconnect
			</button>
		</div>
	{:else if checking}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm text-surface-400">
				<IconLoader class="size-4 animate-spin" />
				Waiting for authorization...
			</div>
			<div class="flex gap-2">
				<button
					class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
					type="button"
					onclick={handleCancel}>
					Cancel
				</button>
			</div>
		</div>
	{:else if cancelled}
		<div class="space-y-3">
			<p class="text-sm text-surface-400">Cancelled.</p>
			<button
				class="btn btn-sm preset-filled-primary-500 w-fit"
				type="button"
				onclick={handleRetry}>
				<IconRotateCcw class="size-4" />
				Retry
			</button>
		</div>
	{:else}
		<p class="text-sm text-surface-400">Not connected.</p>
		<button
			class="btn btn-sm preset-filled-primary-500"
			onclick={handleLogin}>
			Connect ChatGPT
		</button>
	{/if}

	{#if error}
		<div class="card preset-tonal-error p-3 text-sm">
			{error}
		</div>
	{/if}

	{#if lastAction}
		<p class="text-xs text-surface-400">{lastAction}</p>
	{/if}
</div>
