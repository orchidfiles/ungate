import type { AnalyticsSummary, AppSettings, Period, RequestRecord } from '@ungate/shared/frontend';

export class Api {
	private static getPort(): number {
		const injected = (window as unknown as { __PORT__?: number }).__PORT__;

		if (injected) {
			return injected;
		}

		throw new Error('Missing port: window.__PORT__ is not set');
	}

	private static baseUrl(): string {
		return `http://localhost:${this.getPort()}`;
	}

	private static async get<T>(path: string): Promise<T> {
		const response = await fetch(`${this.baseUrl()}${path}`);

		if (!response.ok) {
			throw new Error(`GET ${path} failed: ${response.status}`);
		}

		return response.json() as Promise<T>;
	}

	private static async post<T>(path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl()}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body ?? {})
		});

		if (!response.ok) {
			throw new Error(`POST ${path} failed: ${response.status}`);
		}

		return response.json() as Promise<T>;
	}

	static fetchAnalytics(period: Period): Promise<AnalyticsSummary> {
		return this.get(`/analytics?period=${period}`);
	}

	static fetchRequests(limit: number): Promise<{ requests: RequestRecord[] }> {
		return this.get(`/analytics/requests?limit=${limit}`);
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

	static async healthCheck(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl()}/health`, { signal: AbortSignal.timeout(1000) });

			return response.ok;
		} catch {
			return false;
		}
	}
}
