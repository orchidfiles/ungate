<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconExternalLink from 'virtual:icons/lucide/external-link';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconLogOut from 'virtual:icons/lucide/log-out';

import { Api } from '$shared/api';
import { postExtensionMessage } from '$shared/vscode';

type Phase = 'idle' | 'pending-code' | 'completing';

interface Props {
	onAuthStatusChange?: () => void;
}

let { onAuthStatusChange }: Props = $props();

let authenticated = $state(false);
let email = $state<string | undefined>(undefined);
let loading = $state(true);
let phase = $state<Phase>('idle');
let authUrl = $state('');
let sessionId = $state('');
let codeInput = $state('');
let error = $state<string | null>(null);

$effect(() => {
	void loadStatus();
});

async function loadStatus() {
	loading = true;
	error = null;

	try {
		const status = await Api.authStatus();
		authenticated = status.authenticated;
		email = status.email;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	loading = false;
}

async function handleStartLogin() {
	error = null;

	try {
		const result = await Api.authStart();
		authUrl = result.authUrl;
		sessionId = result.sessionId;
		phase = 'pending-code';
		postExtensionMessage({ type: 'open-external-url', url: authUrl });
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
}

async function handleComplete() {
	error = null;
	phase = 'completing';

	const code = codeInput.trim();

	try {
		const result = await Api.authComplete(code, sessionId);

		if (!result.ok) {
			error = result.error ?? 'Login failed';
			phase = 'pending-code';

			return;
		}

		authenticated = true;
		email = result.email;
		phase = 'idle';
		codeInput = '';
		authUrl = '';
		sessionId = '';
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		phase = 'pending-code';
	}
}

async function handleLogout() {
	error = null;

	try {
		await Api.authLogout();
		authenticated = false;
		email = undefined;
		phase = 'idle';
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
}

function handleCancelLogin() {
	phase = 'idle';
	authUrl = '';
	sessionId = '';
	codeInput = '';
	error = null;
}
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<p class="text-sm font-semibold">Claude</p>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-surface-400">
			<IconLoader class="size-4 animate-spin" />
			Checking status...
		</div>
	{:else if authenticated}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm">
				<IconCheck class="size-4 text-success-500" />
				<span>Logged in{email ? ` as ${email}` : ''}</span>
			</div>
			<button
				class="btn btn-sm preset-filled-surface-500 border border-surface-500/50 hover:preset-filled-surface-400 w-fit"
				onclick={handleLogout}>
				<IconLogOut class="size-4" />
				Logout
			</button>
		</div>
	{:else if phase === 'idle'}
		<p class="text-sm text-surface-400">Not logged in.</p>
		<button
			class="btn btn-sm preset-filled-primary-500"
			onclick={handleStartLogin}>
			Login with Claude
		</button>
	{:else if phase === 'pending-code' || phase === 'completing'}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm text-surface-400">
				<a
					href={authUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="anchor flex items-center gap-1">
					<IconExternalLink class="size-3.5" />
					Open authorization page
				</a>
				<span>— paste the code below</span>
			</div>
			<input
				class="input text-sm font-mono"
				type="text"
				bind:value={codeInput}
				placeholder="CODE#STATE" />
			<div class="flex gap-2">
				<button
					class="btn btn-sm preset-filled-primary-500"
					onclick={handleComplete}
					disabled={phase === 'completing' || !codeInput.trim()}>
					{#if phase === 'completing'}
						<IconLoader class="size-4 animate-spin" />
						Verifying...
					{:else}
						Confirm
					{/if}
				</button>
				<button
					class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
					onclick={handleCancelLogin}
					disabled={phase === 'completing'}>
					Cancel
				</button>
			</div>
		</div>
	{/if}

	{#if error}
		<div class="card preset-tonal-error p-3 text-sm">
			{error}
		</div>
	{/if}
</div>
