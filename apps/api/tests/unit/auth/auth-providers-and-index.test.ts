import { describe, expect, it, vi } from 'vitest';

const oauthGetValidTokenMock = vi.fn();
const oauthGetAuthStatusMock = vi.fn();
const oauthLogoutMock = vi.fn();
const providerGetMock = vi.fn();
const providerHasCredentialsMock = vi.fn();
const providerRemoveMock = vi.fn();

vi.mock('src/auth/oauth', () => ({
	OAuth: {
		getValidToken: (...args: unknown[]) => oauthGetValidTokenMock(...args),
		getAuthStatus: (...args: unknown[]) => oauthGetAuthStatusMock(...args),
		logout: (...args: unknown[]) => oauthLogoutMock(...args)
	}
}));

vi.mock('src/database/provider-settings', () => ({
	ProviderSettings: {
		get: (...args: unknown[]) => providerGetMock(...args),
		hasCredentials: (...args: unknown[]) => providerHasCredentialsMock(...args),
		remove: (...args: unknown[]) => providerRemoveMock(...args)
	}
}));

import { ClaudeProvider } from 'src/auth/claude-provider';
import { getProvider } from 'src/auth/index';
import { MiniMaxProvider } from 'src/auth/minimax-provider';
import { OpenAIProvider } from 'src/auth/openai-provider';

describe('auth providers and index', () => {
	it('claude provider delegates oauth methods', async () => {
		oauthGetValidTokenMock.mockResolvedValueOnce({ accessToken: 'tok' });
		oauthGetAuthStatusMock.mockResolvedValueOnce({ authenticated: true });

		const provider = new ClaudeProvider();
		expect(await provider.getAuthHeader()).toBe('Bearer tok');
		expect(await provider.isAuthenticated()).toBe(true);
		await provider.logout();
		expect(oauthLogoutMock).toHaveBeenCalled();
	});

	it('claude provider returns null auth header without token', async () => {
		oauthGetValidTokenMock.mockResolvedValueOnce(null);
		oauthGetAuthStatusMock.mockResolvedValueOnce({ authenticated: false });

		const provider = new ClaudeProvider();
		expect(await provider.getAuthHeader()).toBeNull();
		expect(await provider.isAuthenticated()).toBe(false);
	});

	it('openai and minimax providers use provider settings', async () => {
		providerGetMock.mockResolvedValueOnce({ accessToken: 'oa' }).mockResolvedValueOnce({ accessToken: 'mm' });

		const openai = new OpenAIProvider();
		const minimax = new MiniMaxProvider();
		expect(await openai.getAuthHeader()).toBe('Bearer oa');
		expect(await minimax.getAuthHeader()).toBe('Bearer mm');

		await openai.logout();
		await minimax.logout();
		expect(providerRemoveMock).toHaveBeenCalledWith('openai');
		expect(providerRemoveMock).toHaveBeenCalledWith('minimax');
	});

	it('openai and minimax providers return null auth headers without tokens', async () => {
		providerGetMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ accessToken: '' });
		providerHasCredentialsMock.mockResolvedValue(false);

		const openai = new OpenAIProvider();
		const minimax = new MiniMaxProvider();
		expect(await openai.getAuthHeader()).toBeNull();
		expect(await openai.isAuthenticated()).toBe(false);
		expect(await minimax.getAuthHeader()).toBeNull();
		expect(await minimax.isAuthenticated()).toBe(false);
	});

	it('getProvider returns undefined for unknown provider names at runtime', () => {
		const provider = getProvider('unknown' as never);
		expect(provider).toBeUndefined();
	});
});
