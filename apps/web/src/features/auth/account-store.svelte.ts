import { untrack } from 'svelte';

import { Api, ApiError, errorMessage } from '$shared/api';
import { postExtensionMessage } from '$shared/vscode';

import type { AccountListResponse, AccountPolicy, SubscriptionAccount, SubscriptionProvider } from '@ungate/shared/frontend';

/**
 * - `starting`: start request in flight.
 * - `awaiting`: session pending — waiting for the OAuth callback (OpenAI) or a pasted `CODE#STATE` (Claude).
 * - `completing`: Claude code exchange in flight.
 * - `conflict`: start was rejected with `login_pending`; the user decides to resume or cancel it.
 */
export type LoginPhase = 'idle' | 'starting' | 'awaiting' | 'completing' | 'conflict';

export interface LoginState {
	phase: LoginPhase;
	sessionId: string | null;
	/** Unknown when resuming a session started elsewhere (the session DTO carries no URL). */
	authUrl: string | null;
	reconnectAccountId: string | null;
	/** Pending session reported by a `login_pending` conflict; null if the server is still starting it. */
	pendingSessionId: string | null;
	/** True when attached to a session this window did not start. */
	resumed: boolean;
	error: string | null;
}

const LIST_POLL_MS = 5000;
/** Live usage fetch interval; proxied responses update usage between fetches via the list poll. */
const USAGE_POLL_MS = 5 * 60_000;
const SESSION_POLL_MS = 1000;
const NOTICE_MS = 6000;

const idleLogin: LoginState = {
	phase: 'idle',
	sessionId: null,
	authUrl: null,
	reconnectAccountId: null,
	pendingSessionId: null,
	resumed: false,
	error: null
};

export class AccountStore {
	readonly provider: SubscriptionProvider;

	accounts = $state<SubscriptionAccount[]>([]);
	policy = $state<AccountPolicy | null>(null);
	loaded = $state(false);
	loading = $state(false);
	/** Error from the last list load; cleared by the next successful load. */
	loadError = $state<string | null>(null);
	/** Error from the last account/login action; cleared by the next action. */
	error = $state<string | null>(null);
	/** Short-lived success message. */
	notice = $state<string | null>(null);
	/** `${action}:${accountId}` (or `policy`) while a mutation is in flight. */
	busy = $state<string | null>(null);
	/** Clock used to expire cooldowns client-side between polls. */
	now = $state(Date.now());
	login = $state<LoginState>({ ...idleLogin });
	/** True while a live usage fetch is in flight. */
	usageBusy = $state(false);

	private attachments = 0;
	private listTimer: ReturnType<typeof setTimeout> | null = null;
	private usageTimer: ReturnType<typeof setTimeout> | null = null;
	private sessionTimer: ReturnType<typeof setTimeout> | null = null;
	private noticeTimer: ReturnType<typeof setTimeout> | null = null;
	/** Bumped by every list write; stale responses with an older sequence are dropped. */
	private listSeq = 0;
	private sessionPolling = false;

	private onVisibilityChange = (): void => {
		if (document.visibilityState === 'visible' && this.attachments > 0) {
			void this.refresh();
			this.scheduleListPoll();
			// The server skips accounts fetched within the last minute, so focus changes stay cheap.
			void this.refreshUsage();
			this.scheduleUsagePoll();
		}
	};

	constructor(provider: SubscriptionProvider) {
		this.provider = provider;
	}

	get activeAccount(): SubscriptionAccount | undefined {
		return this.accounts.find((account) => account.active);
	}

	/** Mirrors legacy `/status`: an active account that does not need login. Null until first load. */
	get authorized(): boolean | null {
		if (!this.loaded) {
			return null;
		}

		const active = this.activeAccount;

		return !!active && active.availability !== 'needs_login';
	}

	get loginActive(): boolean {
		return this.login.phase !== 'idle';
	}

	/** Expired cooldowns become available without waiting for the next poll. */
	availability(account: SubscriptionAccount): SubscriptionAccount['availability'] {
		if (account.availability === 'cooling_down' && account.cooldownUntil !== null && account.cooldownUntil <= this.now) {
			return 'available';
		}

		return account.availability;
	}

	/**
	 * Refreshes the account list while at least one view is attached (visible), plus a session poll
	 * for OpenAI's callback login. Returns the detach function; polling stops with the last view.
	 */
	attach(): () => void {
		this.attachments++;

		if (this.attachments === 1) {
			document.addEventListener('visibilitychange', this.onVisibilityChange);
			window.addEventListener('focus', this.onVisibilityChange);
			// Called from a component $effect: state read here must not become an effect dependency,
			// or every login phase change would detach/re-attach and restart polling.
			untrack(() => {
				void this.refresh();
				this.scheduleListPoll();
				this.ensureSessionPolling();
				void this.refreshUsage();
				this.scheduleUsagePoll();
			});
		}

		let detached = false;

		return () => {
			if (detached) {
				return;
			}

			detached = true;
			this.attachments--;

			if (this.attachments === 0) {
				document.removeEventListener('visibilitychange', this.onVisibilityChange);
				window.removeEventListener('focus', this.onVisibilityChange);
				this.clearListTimer();
				this.clearUsageTimer();
				this.stopSessionPolling();
			}
		};
	}

	/** Fetches live usage from the provider (all accounts, or one). Errors are shown per account. */
	async refreshUsage(accountId?: string): Promise<void> {
		if (this.usageBusy) {
			return;
		}

		this.usageBusy = true;
		const seq = ++this.listSeq;

		try {
			const data = await Api.accountUsageRefresh(this.provider, accountId);

			if (seq === this.listSeq) {
				this.apply(data);
			}
		} catch (e) {
			if (seq === this.listSeq) {
				this.loadError = `Cannot refresh usage: ${errorMessage(e)}`;
			}
		} finally {
			this.usageBusy = false;
		}
	}

	async refresh(): Promise<void> {
		const seq = ++this.listSeq;
		this.loading = true;

		try {
			const data = await Api.accountList(this.provider);

			if (seq === this.listSeq) {
				this.apply(data);
				this.loadError = null;
			}
		} catch (e) {
			if (seq === this.listSeq) {
				this.loadError = `Cannot load accounts: ${errorMessage(e)}`;
			}
		} finally {
			this.loading = false;
		}
	}

	/** Manual override: makes a cooling-down account available again (e.g. after an upgrade). */
	async clearCooldown(account: SubscriptionAccount): Promise<void> {
		await this.mutate(`clear-cooldown:${account.id}`, () => Api.accountClearCooldown(this.provider, account.id), {
			notice: `${account.label} is available again`
		});
	}

	async select(account: SubscriptionAccount): Promise<void> {
		await this.mutate(`select:${account.id}`, () => Api.accountSelect(this.provider, account.id, this.policy?.revision), {
			notice: `Now using ${account.label}`,
			conflict: 'Account selection changed in the meantime (another window or an automatic switch). Review and try again.'
		});
	}

	async rename(account: SubscriptionAccount, label: string): Promise<boolean> {
		return this.mutate(`rename:${account.id}`, () => Api.accountRename(this.provider, account.id, label), {
			notice: 'Account renamed'
		});
	}

	async remove(account: SubscriptionAccount): Promise<boolean> {
		return this.mutate(`remove:${account.id}`, () => Api.accountRemove(this.provider, account.id), {
			notice: `Removed ${account.label}`
		});
	}

	async setAutoSwitch(autoSwitch: boolean): Promise<void> {
		// Last write wins for a boolean toggle: sending the revision would spuriously conflict with
		// automatic switches, which also bump it.
		await this.mutate('policy', () => Api.accountPolicyUpdate(this.provider, autoSwitch), {
			notice: autoSwitch ? 'Automatic switching enabled' : 'Automatic switching disabled'
		});
	}

	async startLogin(reconnectAccountId?: string): Promise<void> {
		if (this.login.phase === 'starting' || this.login.phase === 'completing') {
			return;
		}

		this.error = null;
		this.clearNotice();
		this.login = { ...idleLogin, phase: 'starting', reconnectAccountId: reconnectAccountId ?? null };

		try {
			const result = await Api.accountLoginStart(this.provider, reconnectAccountId);
			this.login = {
				...idleLogin,
				phase: 'awaiting',
				sessionId: result.sessionId,
				authUrl: result.authUrl,
				reconnectAccountId: reconnectAccountId ?? null
			};
			postExtensionMessage({ type: 'open-external-url', url: result.authUrl });
			this.ensureSessionPolling();
		} catch (e) {
			if (e instanceof ApiError && e.code === 'login_pending') {
				this.login = {
					...idleLogin,
					phase: 'conflict',
					reconnectAccountId: reconnectAccountId ?? null,
					pendingSessionId: e.pendingSessionId ?? null
				};

				return;
			}

			this.login = { ...idleLogin };
			this.error = errorMessage(e);

			if (e instanceof ApiError && e.code === 'account_not_found') {
				void this.refresh();
			}
		}
	}

	/** Attaches to the pending session from a `login_pending` conflict and waits for its result. */
	resumePendingLogin(): void {
		const sessionId = this.login.pendingSessionId;

		if (this.login.phase !== 'conflict' || !sessionId) {
			return;
		}

		this.login = { ...idleLogin, phase: 'awaiting', sessionId, resumed: true };
		this.ensureSessionPolling(true);
	}

	/** Cancels the conflicting pending session server-side, then starts the requested login. */
	async cancelPendingAndRestart(): Promise<void> {
		if (this.login.phase !== 'conflict') {
			return;
		}

		const { pendingSessionId, reconnectAccountId } = this.login;

		if (pendingSessionId) {
			this.login = { ...this.login, phase: 'starting' };

			try {
				await Api.accountLoginCancel(this.provider, pendingSessionId);
			} catch (e) {
				// Already finished or expired sessions are no longer pending, which is what we want.
				if (!(e instanceof ApiError && e.code === 'session_not_found')) {
					this.login = { ...this.login, phase: 'conflict', error: errorMessage(e) };

					return;
				}
			}

			this.login = { ...idleLogin };
		}

		await this.startLogin(reconnectAccountId ?? undefined);
	}

	dismissConflict(): void {
		if (this.login.phase === 'conflict') {
			this.login = { ...idleLogin };
		}
	}

	/** Cancels this window's login; the server invalidates the session (and OpenAI's callback listener). */
	async cancelLogin(): Promise<void> {
		const sessionId = this.login.sessionId;
		this.stopSessionPolling();
		this.login = { ...idleLogin };

		if (!sessionId) {
			return;
		}

		try {
			await Api.accountLoginCancel(this.provider, sessionId);
			this.showNotice('Login cancelled');
		} catch (e) {
			if (!(e instanceof ApiError && e.code === 'session_not_found')) {
				this.error = errorMessage(e);
			}
		}
	}

	/** Claude manual flow: submits the pasted `CODE#STATE` for the current session. */
	async completeWithCode(code: string): Promise<void> {
		const sessionId = this.login.sessionId;
		const trimmed = code.trim();

		if (this.login.phase !== 'awaiting' || !sessionId || !trimmed) {
			return;
		}

		this.login = { ...this.login, phase: 'completing', error: null };

		try {
			const result = await Api.accountLoginComplete(trimmed, sessionId);

			if (result.ok) {
				await this.finishLogin(result.accountId);

				return;
			}

			await this.handleCompletionFailure(sessionId, result.error ?? 'Login failed');
		} catch (e) {
			await this.handleCompletionFailure(sessionId, errorMessage(e));
		}
	}

	/** A failed exchange usually consumes the session; keep the paste box only if it is still pending. */
	private async handleCompletionFailure(sessionId: string, message: string): Promise<void> {
		let stillPending = false;

		try {
			const session = await Api.accountLoginSession(this.provider, sessionId);
			stillPending = session.status === 'pending';
		} catch {}

		if (this.login.sessionId !== sessionId) {
			return;
		}

		if (stillPending) {
			this.login = { ...this.login, phase: 'awaiting', error: message };
		} else {
			this.login = { ...idleLogin };
			this.error = `${message}. Start the login again.`;
		}
	}

	private async finishLogin(accountId: string | undefined): Promise<void> {
		const { reconnectAccountId } = this.login;
		const existed = accountId ? this.accounts.some((account) => account.id === accountId) : false;
		this.stopSessionPolling();
		this.login = { ...idleLogin };
		await this.refresh();
		const saved = this.accounts.find((account) => account.id === accountId);
		const name = saved?.label ?? 'Account';

		if (reconnectAccountId) {
			this.showNotice(`${name} reconnected`);
		} else if (existed) {
			this.showNotice(`${name} was already saved; its login was refreshed`);
		} else if (saved && !saved.active) {
			this.showNotice(`${name} added. The active account is unchanged — choose “Use account” to switch.`);
		} else {
			this.showNotice(`${name} connected`);
		}
	}

	private async mutate(
		key: string,
		action: () => Promise<AccountListResponse>,
		messages: { notice: string; conflict?: string }
	): Promise<boolean> {
		this.busy = key;
		this.error = null;
		this.clearNotice();
		const seq = ++this.listSeq;

		try {
			const data = await action();

			if (seq === this.listSeq) {
				this.apply(data);
			}

			this.showNotice(messages.notice);

			return true;
		} catch (e) {
			if (e instanceof ApiError && e.code === 'revision_conflict' && messages.conflict) {
				this.error = messages.conflict;
			} else {
				this.error = errorMessage(e);
			}

			// The list is probably stale (removed elsewhere, cooldown started, selection moved).
			if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
				void this.refresh();
			}

			return false;
		} finally {
			if (this.busy === key) {
				this.busy = null;
			}
		}
	}

	private apply(data: AccountListResponse): void {
		this.accounts = data.accounts;
		this.policy = data.policy;
		this.loaded = true;
		this.now = Date.now();
	}

	private showNotice(message: string): void {
		this.clearNotice();
		this.notice = message;
		this.noticeTimer = setTimeout(() => {
			this.notice = null;
			this.noticeTimer = null;
		}, NOTICE_MS);
	}

	private clearNotice(): void {
		if (this.noticeTimer) {
			clearTimeout(this.noticeTimer);
			this.noticeTimer = null;
		}

		this.notice = null;
	}

	private scheduleListPoll(): void {
		this.clearListTimer();
		this.listTimer = setTimeout(() => {
			this.listTimer = null;

			if (this.attachments === 0) {
				return;
			}

			this.now = Date.now();

			// Skip network work while the webview is hidden; refresh resumes on visibility.
			// A usage refresh returns the full list itself; polling meanwhile would discard its result.
			if (document.visibilityState === 'visible' && this.busy === null && !this.usageBusy) {
				void this.refresh();
			}

			this.scheduleListPoll();
		}, LIST_POLL_MS);
	}

	private clearListTimer(): void {
		if (this.listTimer) {
			clearTimeout(this.listTimer);
			this.listTimer = null;
		}
	}

	private scheduleUsagePoll(): void {
		this.clearUsageTimer();
		this.usageTimer = setTimeout(() => {
			this.usageTimer = null;

			if (this.attachments === 0) {
				return;
			}

			if (document.visibilityState === 'visible') {
				void this.refreshUsage();
			}

			this.scheduleUsagePoll();
		}, USAGE_POLL_MS);
	}

	private clearUsageTimer(): void {
		if (this.usageTimer) {
			clearTimeout(this.usageTimer);
			this.usageTimer = null;
		}
	}

	/** Providers whose login completes through a local callback listener, not a pasted code. */
	get callbackLogin(): boolean {
		return this.provider !== 'claude';
	}

	/** Callback logins (ChatGPT, Gemini) complete server-side, and resumed sessions have no local completion path. */
	private needsSessionPolling(): boolean {
		return this.login.phase === 'awaiting' && !!this.login.sessionId && (this.callbackLogin || this.login.resumed);
	}

	private ensureSessionPolling(immediate = false): void {
		if (this.sessionPolling || this.attachments === 0 || !this.needsSessionPolling()) {
			return;
		}

		this.sessionPolling = true;
		this.scheduleSessionPoll(immediate ? 0 : SESSION_POLL_MS);
	}

	private stopSessionPolling(): void {
		this.sessionPolling = false;

		if (this.sessionTimer) {
			clearTimeout(this.sessionTimer);
			this.sessionTimer = null;
		}
	}

	private scheduleSessionPoll(delay: number): void {
		this.sessionTimer = setTimeout(() => {
			this.sessionTimer = null;
			void this.pollSession();
		}, delay);
	}

	private async pollSession(): Promise<void> {
		const sessionId = this.login.sessionId;

		if (!this.sessionPolling || !sessionId || !this.needsSessionPolling()) {
			this.stopSessionPolling();

			return;
		}

		try {
			const session = await Api.accountLoginSession(this.provider, sessionId);

			if (!this.sessionPolling || this.login.sessionId !== sessionId) {
				return;
			}

			if (session.status === 'succeeded') {
				await this.finishLogin(session.accountId);

				return;
			}

			if (session.status === 'failed' || session.status === 'cancelled') {
				this.stopSessionPolling();
				this.login = { ...idleLogin };

				if (session.status === 'failed') {
					this.error = session.error ?? 'Login failed';
				} else {
					this.showNotice('Login cancelled');
				}

				return;
			}

			this.login = {
				...this.login,
				error: null,
				reconnectAccountId: this.login.reconnectAccountId ?? session.reconnectAccountId ?? null
			};
		} catch (e) {
			if (!this.sessionPolling || this.login.sessionId !== sessionId) {
				return;
			}

			if (e instanceof ApiError && e.code === 'session_not_found') {
				this.stopSessionPolling();
				this.login = { ...idleLogin };
				this.error = 'Login session expired or no longer exists. Start the login again.';

				return;
			}

			// Transient (e.g. API restarting): keep polling and surface the problem.
			this.login = { ...this.login, error: errorMessage(e) };
		}

		this.scheduleSessionPoll(SESSION_POLL_MS);
	}
}

const stores: Record<SubscriptionProvider, AccountStore> = {
	claude: new AccountStore('claude'),
	openai: new AccountStore('openai'),
	gemini: new AccountStore('gemini')
};

/** Module-level store per provider so login state survives provider tab switches. */
export function getAccountStore(provider: SubscriptionProvider): AccountStore {
	return stores[provider];
}
