<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconLogOut from 'virtual:icons/lucide/log-out';

import { Api } from '$shared/api';
import { postExtensionMessage } from '$shared/vscode';

let authenticated = $state(false);
let email = $state<string | undefined>(undefined);
let loading = $state(true);
let checking = $state(false);
let error = $state<string | null>(null);

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

	try {
		const result = await Api.authChatGPTStart();
		postExtensionMessage({ type: 'open-external-url', url: result.authUrl });
		// Poll for auth completion
		const pollInterval = setInterval(() => {
			void (async () => {
				try {
					const status = await Api.authChatGPTStatus();
					if (status.authenticated) {
						clearInterval(pollInterval);
						authenticated = true;
						email = status.email;
						checking = false;
					}
				} catch {
					// Keep polling
				}
			})();
		}, 1000);
		// Stop polling after 5 minutes
		setTimeout(() => {
			clearInterval(pollInterval);
			if (checking) {
				checking = false;
			}
		}, 300_000);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		checking = false;
	}
}

async function handleLogout() {
	error = null;

	try {
		await Api.authChatGPTLogout();
		authenticated = false;
		email = undefined;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<p class="text-sm font-semibold">ChatGPT Authorization</p>

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
				class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500 w-fit"
				onclick={handleLogout}>
				<IconLogOut class="size-4" />
				Disconnect
			</button>
		</div>
	{:else if checking}
		<div class="flex items-center gap-2 text-sm text-surface-400">
			<IconLoader class="size-4 animate-spin" />
			Waiting for authorization...
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
</div>
