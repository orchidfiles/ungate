<script lang="ts">
import IconCopy from 'virtual:icons/lucide/copy';
import IconKeyRound from 'virtual:icons/lucide/key-round';

import { Api, errorMessage } from '$shared/api';
import { Formatter } from '$shared/formatter';

import type { ClientKeyView } from '@ungate/shared/frontend';

let clients = $state<ClientKeyView[]>([]);
let newLabel = $state('');
let minted = $state<{ label: string; key: string } | null>(null);
let busy = $state(false);
let error = $state<string | null>(null);

async function run(action: () => Promise<{ clients: ClientKeyView[] }>): Promise<void> {
	busy = true;
	error = null;
	try {
		clients = (await action()).clients;
	} catch (e) {
		error = errorMessage(e);
	} finally {
		busy = false;
	}
}

async function create(): Promise<void> {
	const label = newLabel.trim();
	if (!label) return;
	await run(async () => {
		const created = await Api.clientCreate(label);
		minted = { label: created.client.label, key: created.key };
		newLabel = '';

		return created;
	});
}

function rename(client: ClientKeyView, label: string): void {
	const trimmed = label.trim();
	if (!trimmed || trimmed === client.label) return;
	void run(() => Api.clientRename(client.id, trimmed));
}

$effect(() => {
	void run(() => Api.clientList());
});
</script>

<div class="card preset-tonal-surface border border-surface-700/30 p-5 space-y-4">
	<div>
		<p class="text-sm font-semibold">Clients</p>
		<p class="text-xs text-surface-400">
			Keys for tools that call the model routes. Usage is recorded per client. A client key never opens accounts, settings or
			analytics; those answer only this machine.
		</p>
	</div>

	{#if error}
		<p class="text-xs text-error-400">{error}</p>
	{/if}

	{#if minted}
		<div class="card preset-tonal-warning p-3 space-y-2">
			<p class="text-xs">Key for <strong>{minted.label}</strong>. It is shown only now; store it where the client reads it.</p>
			<div class="flex gap-2">
				<input
					class="input text-xs font-mono"
					readonly
					value={minted.key} />
				<button
					class="btn btn-sm preset-tonal-surface"
					type="button"
					title="Copy key"
					onclick={() => navigator.clipboard.writeText(minted?.key ?? '')}>
					<IconCopy class="size-4" />
				</button>
				<button
					class="btn btn-sm preset-outlined-surface-700"
					type="button"
					onclick={() => (minted = null)}>Done</button>
			</div>
		</div>
	{/if}

	<div class="space-y-2">
		{#each clients as client (client.id)}
			<div class="flex items-center gap-3 text-sm {client.revokedAt ? 'opacity-50' : ''}">
				<IconKeyRound class="size-4 shrink-0 text-surface-400" />
				{#if client.kind === 'settings'}
					<span class="flex-1"
						>{client.label} <span class="text-xs text-surface-400">— the API key in Server Configuration</span></span>
				{:else}
					<input
						class="input text-sm flex-1"
						value={client.label}
						disabled={busy || client.revokedAt !== null}
						onchange={(event) => rename(client, event.currentTarget.value)} />
				{/if}
				<span class="text-xs text-surface-400 whitespace-nowrap">
					{client.revokedAt ? `revoked ${Formatter.date(client.revokedAt)}` : `added ${Formatter.date(client.createdAt)}`}
				</span>
				{#if client.kind === 'minted' && !client.revokedAt}
					<button
						class="btn btn-sm preset-tonal-error"
						type="button"
						disabled={busy}
						onclick={() => run(() => Api.clientRevoke(client.id))}>Revoke</button>
				{/if}
			</div>
		{/each}
	</div>

	<form
		class="flex gap-2"
		onsubmit={(event) => {
			event.preventDefault();
			void create();
		}}>
		<input
			class="input text-sm"
			placeholder="New client label, e.g. coda-agent"
			maxlength="100"
			bind:value={newLabel} />
		<button
			class="btn btn-sm preset-filled-primary-500"
			type="submit"
			disabled={busy || !newLabel.trim()}>Create key</button>
	</form>
</div>
