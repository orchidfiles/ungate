<script lang="ts">
import { sleep } from '@ungate/shared/frontend';
import IconCheck from 'virtual:icons/lucide/check';
import IconClock from 'virtual:icons/lucide/clock';
import IconCopy from 'virtual:icons/lucide/copy';
import IconGauge from 'virtual:icons/lucide/gauge';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconPencil from 'virtual:icons/lucide/pencil';
import IconRefreshCw from 'virtual:icons/lucide/refresh-cw';
import IconTimerReset from 'virtual:icons/lucide/timer-reset';
import IconTrash2 from 'virtual:icons/lucide/trash-2';
import IconTriangleAlert from 'virtual:icons/lucide/triangle-alert';
import IconUserPlus from 'virtual:icons/lucide/user-plus';
import IconUserRoundCheck from 'virtual:icons/lucide/user-round-check';

import InfoTooltip from '$shared/InfoTooltip.svelte';

import { accountSubtitle, formatCooldown, formatCooldownReason, formatSwitchReason } from './account-format';
import UsageBars from './UsageBars.svelte';

import type { AccountStore } from './account-store.svelte';
import type { SubscriptionAccount } from '@ungate/shared/frontend';
import type { Snippet } from 'svelte';

interface Props {
	store: AccountStore;
	/** Display name, e.g. "Claude" or "ChatGPT". */
	providerName: string;
	/** Website whose browser login decides which subscription is connected, e.g. "claude.ai". */
	providerSite: string;
	/** Provider-specific UI for an in-progress login (`awaiting`/`completing` phases). */
	loginPanel: Snippet;
}

let { store, providerName, providerSite, loginPanel }: Props = $props();

let editingId = $state<string | null>(null);
let editLabel = $state('');
let confirmRemove = $state<SubscriptionAccount | null>(null);
let copiedLink = $state(false);

$effect(() => store.attach());

const loginBusy = $derived(store.login.phase === 'starting' || store.login.phase === 'completing');
const reconnectTarget = $derived(
	store.login.reconnectAccountId ? store.accounts.find((account) => account.id === store.login.reconnectAccountId) : undefined
);
const editValid = $derived(editLabel.trim().length >= 1 && editLabel.trim().length <= 100);

function availabilityBadge(account: SubscriptionAccount): { label: string; class: string } {
	const availability = store.availability(account);

	if (availability === 'needs_login') {
		return { label: 'Needs login', class: 'preset-tonal-error' };
	}

	if (availability === 'cooling_down') {
		return { label: 'Cooling down', class: 'preset-tonal-warning' };
	}

	return { label: 'Available', class: 'preset-tonal-success' };
}

function useDisabledReason(account: SubscriptionAccount): string | null {
	const availability = store.availability(account);

	if (availability === 'needs_login') {
		return 'Reconnect this account before using it';
	}

	if (availability === 'cooling_down') {
		return 'This account recently hit a usage limit';
	}

	return null;
}

function isBusy(action: string, account: SubscriptionAccount): boolean {
	return store.busy === `${action}:${account.id}`;
}

function startEdit(account: SubscriptionAccount): void {
	editingId = account.id;
	editLabel = account.label;
}

function cancelEdit(): void {
	editingId = null;
	editLabel = '';
}

async function saveEdit(account: SubscriptionAccount): Promise<void> {
	const label = editLabel.trim();

	if (!editValid) {
		return;
	}

	if (label === account.label) {
		cancelEdit();

		return;
	}

	if (await store.rename(account, label)) {
		cancelEdit();
	}
}

function handleEditKeydown(event: KeyboardEvent, account: SubscriptionAccount): void {
	if (event.key === 'Enter') {
		event.preventDefault();
		void saveEdit(account);
	} else if (event.key === 'Escape') {
		event.preventDefault();
		cancelEdit();
	}
}

function focusOnMount(node: HTMLInputElement): void {
	node.focus();
	node.select();
}

async function handleConfirmRemove(): Promise<void> {
	const account = confirmRemove;

	if (!account) {
		return;
	}

	confirmRemove = null;

	if (editingId === account.id) {
		cancelEdit();
	}

	await store.remove(account);
}

function handleAutoSwitchChange(event: Event): void {
	const target = event.currentTarget as HTMLInputElement;
	void store.setAutoSwitch(target.checked);
}

async function copyLoginLink(): Promise<void> {
	if (!store.login.authUrl) {
		return;
	}

	await navigator.clipboard.writeText(store.login.authUrl);
	copiedLink = true;
	await sleep(1500);
	copiedLink = false;
}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<p class="text-sm font-semibold">{providerName} accounts</p>
			<InfoTooltip
				text={`Sign-in uses whichever ${providerName} account your browser is currently logged into at ${providerSite}. To add another subscription, switch accounts there first or open the login link in a separate browser profile.`}>
				<span class="badge preset-tonal-surface text-xs cursor-help">?</span>
			</InfoTooltip>
			{#if store.loading && !store.loaded}
				<IconLoader class="size-3.5 animate-spin text-surface-400" />
			{/if}
		</div>
		{#if store.accounts.length > 0}
			<div class="flex flex-wrap items-center gap-2">
				<button
					class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
					type="button"
					title="Fetch current usage limits from {providerName}"
					onclick={() => void store.refreshUsage()}
					disabled={store.usageBusy}>
					{#if store.usageBusy}
						<IconLoader class="size-4 animate-spin" />
					{:else}
						<IconGauge class="size-4" />
					{/if}
					Refresh usage
				</button>
				<button
					class="btn btn-sm preset-filled-primary-500"
					type="button"
					onclick={() => void store.startLogin()}
					disabled={store.loginActive}>
					{#if store.login.phase === 'starting' && !store.login.reconnectAccountId}
						<IconLoader class="size-4 animate-spin" />
					{:else}
						<IconUserPlus class="size-4" />
					{/if}
					Add account
				</button>
			</div>
		{/if}
	</div>

	{#if store.loaded}
		<div class="card preset-tonal-surface border border-surface-700/30 p-3 space-y-2">
			<label class="flex items-start gap-3 cursor-pointer">
				<input
					class="checkbox mt-0.5"
					type="checkbox"
					checked={store.policy?.autoSwitch ?? true}
					disabled={store.busy === 'policy'}
					onchange={handleAutoSwitchChange} />
				<span class="text-sm leading-5">Automatically switch on usage limits</span>
			</label>
			<p class="text-xs text-surface-400">
				When the active account reports a usage limit, Ungate moves new requests to the next available saved account and keeps
				using it. Requests already in progress are not moved.
			</p>
			{#if store.policy?.lastSwitchReason}
				<p class="text-xs text-surface-400">
					Last switch: <span class="text-surface-200">{formatSwitchReason(store.policy.lastSwitchReason)}</span>
				</p>
			{/if}
		</div>
	{/if}

	{#if store.login.phase === 'conflict'}
		<div class="card preset-tonal-warning p-3 space-y-3 text-sm">
			<div class="flex items-start gap-2">
				<IconTriangleAlert class="size-4 mt-0.5 shrink-0" />
				<p>
					Another {providerName} login is already in progress, possibly in another window or an unfinished browser tab. Only one can
					run at a time.
				</p>
			</div>
			{#if store.login.error}
				<p class="text-xs">{store.login.error}</p>
			{/if}
			<div class="flex flex-wrap gap-2">
				{#if store.login.pendingSessionId}
					<button
						class="btn btn-sm preset-filled-surface-500"
						type="button"
						onclick={() => store.resumePendingLogin()}>
						Wait for that login
					</button>
					<button
						class="btn btn-sm preset-filled-primary-500"
						type="button"
						onclick={() => void store.cancelPendingAndRestart()}>
						Cancel it and start a new login
					</button>
				{:else}
					<button
						class="btn btn-sm preset-filled-primary-500"
						type="button"
						onclick={() => void store.startLogin(store.login.reconnectAccountId ?? undefined)}>
						Try again
					</button>
				{/if}
				<button
					class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
					type="button"
					onclick={() => store.dismissConflict()}>
					Dismiss
				</button>
			</div>
		</div>
	{:else if store.login.phase === 'awaiting' || store.login.phase === 'completing'}
		<div class="card preset-tonal-surface border border-primary-500/40 p-4 space-y-3">
			<p class="text-sm font-medium">
				{#if store.login.resumed}
					Waiting for a login started elsewhere
				{:else if store.login.reconnectAccountId}
					Reconnecting {reconnectTarget?.label ?? 'account'}
				{:else}
					Adding a {providerName} account
				{/if}
			</p>
			{#if store.login.reconnectAccountId && !store.login.resumed}
				<p class="text-xs text-surface-400">
					Sign in as the same {providerName} account; a different account will be rejected.
				</p>
			{/if}
			{@render loginPanel()}
			{#if store.login.authUrl}
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-surface-400">
					<span>Wrong browser account? Copy the link into a separate browser profile.</span>
					<button
						class="btn btn-sm h-auto min-h-0 px-2 py-0.5 preset-tonal-surface"
						type="button"
						onclick={() => void copyLoginLink()}>
						<IconCopy class="size-3.5" />
						{copiedLink ? 'Copied' : 'Copy link'}
					</button>
				</div>
			{/if}
			{#if store.login.error}
				<div class="card preset-tonal-error p-2 text-xs">{store.login.error}</div>
			{/if}
		</div>
	{/if}

	{#if store.error}
		<div class="card preset-tonal-error p-3 text-sm">{store.error}</div>
	{/if}
	{#if store.loadError}
		<div class="card preset-tonal-error p-3 text-sm">{store.loadError}</div>
	{/if}
	{#if store.notice}
		<div class="card preset-tonal-success p-3 text-sm">{store.notice}</div>
	{/if}

	{#if !store.loaded}
		{#if !store.loadError}
			<div class="flex items-center gap-2 text-sm text-surface-400">
				<IconLoader class="size-4 animate-spin" />
				Loading accounts...
			</div>
		{/if}
	{:else if store.accounts.length === 0}
		{#if !store.loginActive}
			<div class="space-y-3">
				<p class="text-sm text-surface-400">No {providerName} accounts connected.</p>
				<button
					class="btn btn-sm preset-filled-primary-500"
					type="button"
					onclick={() => void store.startLogin()}>
					<IconUserPlus class="size-4" />
					Connect {providerName}
				</button>
			</div>
		{/if}
	{:else}
		<ul class="space-y-2">
			{#each store.accounts as account (account.id)}
				{@const badge = availabilityBadge(account)}
				{@const cooldown = store.availability(account) === 'cooling_down' ? formatCooldown(account, store.now) : null}
				{@const disabledReason = useDisabledReason(account)}
				{@const subtitle = accountSubtitle(account)}
				<li
					class="card border p-3 space-y-2 {account.active
						? 'preset-tonal-primary border-primary-500/40'
						: 'preset-tonal-surface border-surface-700/30'}">
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div class="min-w-0 flex-1 space-y-1">
							{#if editingId === account.id}
								<div class="flex flex-wrap items-center gap-2">
									<input
										class="input text-sm max-w-xs"
										type="text"
										maxlength={100}
										aria-label="Account label"
										bind:value={editLabel}
										use:focusOnMount
										onkeydown={(event) => handleEditKeydown(event, account)} />
									<button
										class="btn btn-sm preset-filled-primary-500"
										type="button"
										disabled={!editValid || isBusy('rename', account)}
										onclick={() => void saveEdit(account)}>
										{#if isBusy('rename', account)}
											<IconLoader class="size-4 animate-spin" />
										{/if}
										Save
									</button>
									<button
										class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
										type="button"
										onclick={cancelEdit}>
										Cancel
									</button>
								</div>
							{:else}
								<div class="flex flex-wrap items-center gap-2">
									<span class="text-sm font-medium truncate">{account.label}</span>
									{#if account.active}
										<span class="badge preset-filled-primary-500 text-xs">
											<IconCheck class="size-3" />
											Active
										</span>
									{/if}
									<span class="badge text-xs {badge.class}">{badge.label}</span>
								</div>
							{/if}
							{#if subtitle}
								<p class="text-xs text-surface-400 truncate">{subtitle}</p>
							{/if}
							{#if cooldown}
								<p class="flex items-center gap-1 text-xs text-warning-400">
									<IconClock class="size-3.5" />
									{cooldown}{account.cooldownReason ? ` · ${formatCooldownReason(account.cooldownReason)}` : ''}
								</p>
							{:else if store.availability(account) === 'needs_login'}
								<p class="text-xs text-error-400">The saved login expired or was revoked. Reconnect to use this account.</p>
							{/if}
							{#if editingId !== account.id}
								{#if account.usage}
									<div class="pt-1">
										<UsageBars
											usage={account.usage}
											now={store.now} />
									</div>
								{:else if store.availability(account) !== 'needs_login'}
									<p class="flex items-center gap-1 text-xs text-surface-500">
										{#if store.usageBusy}
											<IconLoader class="size-3 animate-spin" />
											Loading usage...
										{:else}
											Usage not loaded yet
										{/if}
									</p>
								{/if}
							{/if}
						</div>

						{#if editingId !== account.id}
							<div class="flex flex-wrap items-center gap-2">
								{#if !account.active}
									<button
										class="btn btn-sm preset-filled-surface-500 border border-surface-500/50 hover:preset-filled-surface-400"
										type="button"
										title={disabledReason ?? `Send new ${providerName} requests through this account`}
										disabled={!!disabledReason || store.busy !== null}
										onclick={() => void store.select(account)}>
										{#if isBusy('select', account)}
											<IconLoader class="size-4 animate-spin" />
										{:else}
											<IconUserRoundCheck class="size-4" />
										{/if}
										Use account
									</button>
								{/if}
								{#if store.availability(account) === 'cooling_down'}
									<button
										class="btn btn-sm preset-outlined-warning-500"
										type="button"
										title="Make this account available now, e.g. after upgrading its plan"
										disabled={store.busy !== null}
										onclick={() => void store.clearCooldown(account)}>
										{#if isBusy('clear-cooldown', account)}
											<IconLoader class="size-4 animate-spin" />
										{:else}
											<IconTimerReset class="size-4" />
										{/if}
										Clear cooldown
									</button>
								{/if}
								<button
									class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
									type="button"
									title="Rename"
									disabled={store.busy !== null}
									onclick={() => startEdit(account)}>
									<IconPencil class="size-4" />
									Rename
								</button>
								<button
									class="btn btn-sm {store.availability(account) === 'needs_login'
										? 'preset-filled-primary-500'
										: 'preset-outlined-surface-700 hover:preset-filled-surface-500'}"
									type="button"
									title="Sign in again to refresh this account's login"
									disabled={store.loginActive || loginBusy}
									onclick={() => void store.startLogin(account.id)}>
									{#if store.login.phase === 'starting' && store.login.reconnectAccountId === account.id}
										<IconLoader class="size-4 animate-spin" />
									{:else}
										<IconRefreshCw class="size-4" />
									{/if}
									Reconnect
								</button>
								<button
									class="btn btn-sm preset-outlined-error-500"
									type="button"
									title="Remove"
									disabled={store.busy !== null}
									onclick={() => (confirmRemove = account)}>
									{#if isBusy('remove', account)}
										<IconLoader class="size-4 animate-spin" />
									{:else}
										<IconTrash2 class="size-4" />
									{/if}
									Remove
								</button>
							</div>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if confirmRemove}
	<div class="fixed inset-0 z-30 flex items-center justify-center bg-surface-950/70 p-4">
		<div
			class="card preset-tonal-surface border border-surface-700/30 w-full max-w-md p-5 space-y-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby="remove-account-title">
			<p
				id="remove-account-title"
				class="text-sm font-semibold">
				Remove {providerName} account
			</p>
			<p class="text-sm text-surface-400">
				Remove <span class="text-surface-100 font-medium">{confirmRemove.label}</span> and its saved login from Ungate?
				{#if confirmRemove.active}
					It is the active account; the next available saved account will be used instead.
				{/if}
				You can add it again later by signing in.
			</p>
			<div class="flex justify-end gap-2">
				<button
					class="btn btn-sm preset-outlined-surface-700 hover:preset-filled-surface-500"
					type="button"
					onclick={() => (confirmRemove = null)}>
					Cancel
				</button>
				<button
					class="btn btn-sm preset-outlined-error-500"
					type="button"
					onclick={() => void handleConfirmRemove()}>
					<IconTrash2 class="size-4" />
					Remove
				</button>
			</div>
		</div>
	</div>
{/if}
