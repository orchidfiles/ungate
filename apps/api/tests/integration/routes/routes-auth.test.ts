import { afterEach, describe, expect, it, vi } from 'vitest';

import authPlugin from 'src/routes/auth';

import { withPlugin } from '../test-harness';

const oauthStartLoginMock = vi.fn();
const oauthCompleteLoginMock = vi.fn();
const oauthStatusMock = vi.fn();
const oauthLogoutMock = vi.fn();

const openaiStartLoginMock = vi.fn();
const openaiCompleteLoginMock = vi.fn();
const openaiStatusMock = vi.fn();
const openaiLogoutMock = vi.fn();

const providerGetMock = vi.fn();
const providerUpsertApiKeyMock = vi.fn();
const providerRemoveMock = vi.fn();

vi.mock('src/auth/oauth', () => ({
	OAuth: {
		startLogin: (...args: unknown[]) => oauthStartLoginMock(...args),
		completeLogin: (...args: unknown[]) => oauthCompleteLoginMock(...args),
		getAuthStatus: (...args: unknown[]) => oauthStatusMock(...args),
		logout: (...args: unknown[]) => oauthLogoutMock(...args)
	}
}));

vi.mock('src/auth/openai/openai-oauth-service', () => ({
	OpenAIOAuthService: {
		startLogin: (...args: unknown[]) => openaiStartLoginMock(...args),
		completeLogin: (...args: unknown[]) => openaiCompleteLoginMock(...args),
		getAuthStatus: (...args: unknown[]) => openaiStatusMock(...args),
		logout: (...args: unknown[]) => openaiLogoutMock(...args)
	}
}));

vi.mock('src/database/provider-settings', () => ({
	ProviderSettings: {
		get: (...args: unknown[]) => providerGetMock(...args),
		upsertApiKey: (...args: unknown[]) => providerUpsertApiKeyMock(...args),
		remove: (...args: unknown[]) => providerRemoveMock(...args)
	}
}));

describe('routes-auth', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('handles claude start/complete/status/logout', async () => {
		oauthStartLoginMock.mockResolvedValueOnce({ authUrl: 'u', sessionId: 's' });
		oauthCompleteLoginMock.mockResolvedValueOnce({ ok: true, email: 'e@e.com' });
		oauthStatusMock.mockReturnValueOnce({ authenticated: true });

		const app = await withPlugin(authPlugin);

		const start = await app.inject({ method: 'POST', url: '/auth/claude/start' });
		expect(start.statusCode).toBe(200);
		expect(start.json()).toEqual({ authUrl: 'u', sessionId: 's' });

		const bad = await app.inject({ method: 'POST', url: '/auth/claude/complete', payload: { code: 'x' } });
		expect(bad.statusCode).toBe(400);

		const complete = await app.inject({
			method: 'POST',
			url: '/auth/claude/complete',
			payload: { code: 'x', sessionId: 'sid' }
		});
		expect(complete.json()).toEqual({ ok: true, email: 'e@e.com' });

		const status = await app.inject({ method: 'GET', url: '/auth/claude/status' });
		expect(status.json()).toEqual({ authenticated: true });

		const logout = await app.inject({ method: 'POST', url: '/auth/claude/logout' });
		expect(logout.json()).toEqual({ ok: true });
		expect(oauthLogoutMock).toHaveBeenCalled();
		await app.close();
	});

	it('handles minimax login/status/logout contracts', async () => {
		providerGetMock.mockReturnValueOnce({ accessToken: 'k', baseUrl: 'https://x' });
		const app = await withPlugin(authPlugin);

		const status = await app.inject({ method: 'GET', url: '/auth/minimax/status' });
		expect(status.json()).toEqual({ authenticated: true, baseUrl: 'https://x' });

		const badLogin = await app.inject({
			method: 'POST',
			url: '/auth/minimax/login',
			payload: { apiKey: '   ' }
		});
		expect(badLogin.statusCode).toBe(400);

		const login = await app.inject({
			method: 'POST',
			url: '/auth/minimax/login',
			payload: { apiKey: ' key ', baseUrl: ' https://m ' }
		});
		expect(login.json()).toEqual({ ok: true });
		expect(providerUpsertApiKeyMock).toHaveBeenCalledWith('minimax', 'key', 'https://m');

		const logout = await app.inject({ method: 'POST', url: '/auth/minimax/logout' });
		expect(logout.json()).toEqual({ ok: true });
		expect(providerRemoveMock).toHaveBeenCalledWith('minimax');
		await app.close();
	});

	it('handles openai callback html responses', async () => {
		openaiStartLoginMock.mockResolvedValueOnce({ authUrl: 'openai-url', sessionId: 'sid' });
		openaiStatusMock.mockReturnValueOnce({ authenticated: false });
		openaiCompleteLoginMock.mockResolvedValueOnce({ ok: true });
		const app = await withPlugin(authPlugin);

		const start = await app.inject({ method: 'GET', url: '/auth/openai/start' });
		expect(start.json().authUrl).toBe('openai-url');

		const missing = await app.inject({ method: 'GET', url: '/auth/openai/callback' });
		expect(missing.statusCode).toBe(200);
		expect(missing.body).toContain('Missing code or session');

		const success = await app.inject({ method: 'GET', url: '/auth/openai/callback?code=abc&state=state1' });
		expect(success.body).toContain('Connected!');

		openaiCompleteLoginMock.mockResolvedValueOnce({ ok: false, error: 'boom' });
		const failure = await app.inject({ method: 'GET', url: '/auth/openai/callback?code=abc&state=state2' });
		expect(failure.body).toContain('Error');
		expect(failure.body).toContain('boom');

		const status = await app.inject({ method: 'GET', url: '/auth/openai/status' });
		expect(status.json()).toEqual({ authenticated: false });

		await app.inject({ method: 'POST', url: '/auth/openai/logout' });
		expect(openaiLogoutMock).toHaveBeenCalled();
		await app.close();
	});
});
