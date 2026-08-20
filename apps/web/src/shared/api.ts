import {
	ADMIN_KEY_HEADER,
	sleep,
	type AnalyticsSummary,
	type AppSettings,
	type Period,
	type RequestRecord,
	type TokenSeriesPoint
} from '@ungate/shared/frontend';

export class Api {
	private static port: number | null = window.__PORT__ ?? null;
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
		const injected = window.__PORT__;

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

		return `http://localhost:${port}`;
	}

	/**
	 * Administrative routes (settings, provider auth, analytics) require the admin key that the
	 * extension injects into this webview. It is read per request rather than cached, so a webview
	 * HTML rebuild always wins. Proxy routes are never called from here.
	 */
	private static adminHeaders(base?: Record<string, string>): Record<string, string> {
		const key = window.__ADMIN_KEY__;
		const headers: Record<string, string> = { ...base };

		if (key) {
			headers[ADMIN_KEY_HEADER] = key;
		}

		return headers;
	}

	private static async get<T>(path: string): Promise<T> {
		const baseUrl = await this.baseUrl();
		const response = await fetch(`${baseUrl}${path}`, { headers: this.adminHeaders() });

		if (!response.ok) {
			throw new Error(`GET ${path} failed: ${response.status}`);
		}

		return response.json() as Promise<T>;
	}

	private static async post<T>(path: string, body?: unknown): Promise<T> {
		const baseUrl = await this.baseUrl();
		const response = await fetch(`${baseUrl}${path}`, {
			method: 'POST',
			headers: this.adminHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify(body ?? {})
		});

		if (!response.ok) {
			let detail = '';
			try {
				const body = (await response.json()) as { error?: string };
				detail = body.error ?? '';
			} catch {}

			throw new Error(`POST ${path} failed: ${response.status}${detail ? ` — ${detail}` : ''}`);
		}

		return response.json() as Promise<T>;
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

	static resetAnalytics(): Promise<{ success: boolean; deletedCount: number }> {
		return this.post('/analytics/reset');
	}

	static fetchSettings(): Promise<AppSettings> {
		return this.get('/settings');
	}

	static updateSettings(settings: Partial<AppSettings>): Promise<{ ok: boolean }> {
		return this.post('/settings', settings);
	}

	static authStart(): Promise<{ authUrl: string; sessionId: string }> {
		return this.post('/auth/claude/start');
	}

	static authComplete(code: string, sessionId: string): Promise<{ ok: boolean; email?: string; error?: string }> {
		return this.post('/auth/claude/complete', { code, sessionId });
	}

	static authStatus(): Promise<{ authenticated: boolean; email?: string }> {
		return this.get('/auth/claude/status');
	}

	static authLogout(): Promise<{ ok: boolean }> {
		return this.post('/auth/claude/logout');
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

	static authChatGPTStart(): Promise<{ authUrl: string; sessionId: string }> {
		return this.get('/auth/openai/start');
	}

	static authChatGPTStatus(): Promise<{ authenticated: boolean; email?: string }> {
		return this.get('/auth/openai/status');
	}

	static authChatGPTLogout(): Promise<{ ok: boolean }> {
		return this.post('/auth/openai/logout');
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
