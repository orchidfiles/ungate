import {
	localApiBaseUrl,
	sleep,
	type AccountErrorResponse,
	type AccountListResponse,
	type AccountLoginCompleteRequest,
	type AccountLoginCompleteResponse,
	type AccountLoginSession,
	type AccountLoginStartRequest,
	type AccountLoginStartResponse,
	type AccountPolicyRequest,
	type AccountRenameRequest,
	type AccountSelectRequest,
	type AccountUsageRefreshRequest,
	type AnalyticsSummary,
	type AppSettings,
	type Period,
	type RequestRecord,
	type SubscriptionProvider,
	type TokenSeriesPoint,
	type UsageInsights
} from '@ungate/shared/frontend';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Non-2xx API response. `code`/`pendingSessionId` come from `AccountErrorResponse` bodies when present. */
export class ApiError extends Error {
	readonly status: number;
	/** Server-provided human-readable message (`error` field), or empty. */
	readonly detail: string;
	/** An `AccountErrorCode` for account endpoints; other endpoints may return other codes. */
	readonly code: string | undefined;
	readonly pendingSessionId: string | undefined;

	constructor(message: string, init: { status: number; detail: string; code?: string; pendingSessionId?: string }) {
		super(message);
		this.name = 'ApiError';
		this.status = init.status;
		this.detail = init.detail;
		this.code = init.code;
		this.pendingSessionId = init.pendingSessionId;
	}
}

/** Prefers the server's message over the transport-level description. */
export function errorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		return error.detail || error.message;
	}

	return error instanceof Error ? error.message : String(error);
}

export class Api {
	private static port: number | null = (window as unknown as { __PORT__?: number | null }).__PORT__ ?? null;
	private static readonly portWaiters = new Set<(port: number) => void>();

	static {
		window.addEventListener('message', (event: MessageEvent) => {
			const message = event.data as { type?: string; port?: number | null };

			if (message.type === 'port') {
				this.port = message.port ?? null;

				if (message.port) {
					for (const resolve of this.portWaiters) {
						resolve(message.port);
					}

					this.portWaiters.clear();
				}
			}
		});
	}

	private static async getPort(): Promise<number> {
		const injected = (window as unknown as { __PORT__?: number | null }).__PORT__;

		if (injected) {
			return injected;
		}

		if (this.port) {
			return this.port;
		}

		const port = await new Promise<number>((resolve, reject) => {
			const resolveWithCleanup = (nextPort: number) => {
				this.portWaiters.delete(resolveWithCleanup);
				resolve(nextPort);
			};

			this.portWaiters.add(resolveWithCleanup);

			void sleep(5000)
				.then(() => {
					this.portWaiters.delete(resolveWithCleanup);
					reject(new Error('Ungate API is still starting'));
				})
				.catch(() => {});
		});

		return port;
	}

	private static async baseUrl(): Promise<string> {
		const port = await this.getPort();

		return localApiBaseUrl(port);
	}

	private static async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
		const baseUrl = await this.baseUrl();
		// Fastify rejects an empty body declared as JSON, so body-less methods send no Content-Type.
		const hasBody = method === 'POST' || method === 'PATCH';
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			...(hasBody && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
		});

		if (!response.ok) {
			let detail = '';
			let code: string | undefined;
			let pendingSessionId: string | undefined;
			try {
				const errorBody = (await response.json()) as Partial<AccountErrorResponse>;
				detail = typeof errorBody.error === 'string' ? errorBody.error : '';
				code = typeof errorBody.code === 'string' ? errorBody.code : undefined;
				pendingSessionId = typeof errorBody.pendingSessionId === 'string' ? errorBody.pendingSessionId : undefined;
			} catch {}

			throw new ApiError(`${method} ${path} failed: ${response.status}${detail ? ` — ${detail}` : ''}`, {
				status: response.status,
				detail,
				code,
				pendingSessionId
			});
		}

		return response.json() as Promise<T>;
	}

	private static get<T>(path: string): Promise<T> {
		return this.request('GET', path);
	}

	private static post<T>(path: string, body?: unknown): Promise<T> {
		return this.request('POST', path, body);
	}

	private static patch<T>(path: string, body: unknown): Promise<T> {
		return this.request('PATCH', path, body);
	}

	private static delete<T>(path: string): Promise<T> {
		return this.request('DELETE', path);
	}

	static fetchAnalytics(period: Period): Promise<AnalyticsSummary> {
		return this.get(`/analytics?period=${period}`);
	}

	static fetchRequests(limit: number): Promise<{ requests: RequestRecord[] }> {
		return this.get(`/analytics/requests?limit=${limit}`);
	}

	static fetchTokenSeries(period: Period): Promise<{ period: Period; series: TokenSeriesPoint[] }> {
		return this.get(`/analytics/tokens?period=${period}`);
	}

	static fetchInsights(period: Period): Promise<UsageInsights> {
		return this.get(`/analytics/insights?period=${period}`);
	}

	static resetAnalytics(): Promise<{ success: boolean; deletedCount: number }> {
		return this.post('/analytics/reset');
	}

	static fetchSettings(): Promise<AppSettings> {
		return this.get('/settings');
	}

	static updateSettings(settings: Partial<AppSettings>): Promise<{ ok: boolean }> {
		return this.post('/settings', settings);
	}

	/** Legacy status: reflects the provider's active account only. */
	static authStatus(): Promise<{ authenticated: boolean; email?: string }> {
		return this.get('/auth/claude/status');
	}

	static accountLoginStart(provider: SubscriptionProvider, accountId?: string): Promise<AccountLoginStartResponse> {
		const body: AccountLoginStartRequest = accountId ? { accountId } : {};

		return this.post(`/auth/${provider}/start`, body);
	}

	/** Claude only: exchanges the manually pasted `CODE#STATE` for the given login session. */
	static accountLoginComplete(code: string, sessionId: string): Promise<AccountLoginCompleteResponse> {
		const body: AccountLoginCompleteRequest = { code, sessionId };

		return this.post('/auth/claude/complete', body);
	}

	static accountLoginSession(provider: SubscriptionProvider, sessionId: string): Promise<AccountLoginSession> {
		return this.get(`/auth/${provider}/sessions/${encodeURIComponent(sessionId)}`);
	}

	static accountLoginCancel(provider: SubscriptionProvider, sessionId: string): Promise<AccountLoginSession> {
		return this.post(`/auth/${provider}/sessions/${encodeURIComponent(sessionId)}/cancel`);
	}

	static accountList(provider: SubscriptionProvider): Promise<AccountListResponse> {
		return this.get(`/auth/${provider}/accounts`);
	}

	static accountRename(provider: SubscriptionProvider, accountId: string, label: string): Promise<AccountListResponse> {
		const body: AccountRenameRequest = { label };

		return this.patch(`/auth/${provider}/accounts/${encodeURIComponent(accountId)}`, body);
	}

	static accountSelect(provider: SubscriptionProvider, accountId: string, revision?: number): Promise<AccountListResponse> {
		const body: AccountSelectRequest = revision === undefined ? {} : { revision };

		return this.post(`/auth/${provider}/accounts/${encodeURIComponent(accountId)}/select`, body);
	}

	static accountRemove(provider: SubscriptionProvider, accountId: string): Promise<AccountListResponse> {
		return this.delete(`/auth/${provider}/accounts/${encodeURIComponent(accountId)}`);
	}

	static accountPolicyUpdate(provider: SubscriptionProvider, autoSwitch: boolean): Promise<AccountListResponse> {
		const body: AccountPolicyRequest = { autoSwitch };

		return this.patch(`/auth/${provider}/policy`, body);
	}

	/** Fetches live subscription usage (all accounts, or one); the server throttles per account. */
	static accountUsageRefresh(provider: SubscriptionProvider, accountId?: string): Promise<AccountListResponse> {
		const body: AccountUsageRefreshRequest = accountId ? { accountId } : {};

		return this.post(`/auth/${provider}/usage/refresh`, body);
	}

	static authMinimaxStatus(): Promise<{ authenticated: boolean; baseUrl?: string }> {
		return this.get('/auth/minimax/status');
	}

	static authMinimaxLogin(apiKey: string, baseUrl: string): Promise<{ ok: boolean; error?: string }> {
		return this.post('/auth/minimax/login', { apiKey, baseUrl });
	}

	static authMinimaxUpdateBaseUrl(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
		return this.post('/auth/minimax/base-url', { baseUrl });
	}

	static authMinimaxLogout(): Promise<{ ok: boolean }> {
		return this.post('/auth/minimax/logout');
	}

	/** Legacy status: reflects the provider's active account only. */
	static authChatGPTStatus(): Promise<{ authenticated: boolean; email?: string }> {
		return this.get('/auth/openai/status');
	}

	static async healthCheck(): Promise<boolean> {
		try {
			const baseUrl = await this.baseUrl();
			const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });

			return response.ok;
		} catch {
			return false;
		}
	}
}
