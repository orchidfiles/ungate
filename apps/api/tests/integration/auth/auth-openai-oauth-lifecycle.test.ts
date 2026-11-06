import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOAuthService } from 'src/auth/openai/openai-oauth-service';
import { OpenAIPkceSessionStore } from 'src/auth/openai/pkce-session-store';
import { ProviderSettings } from 'src/database/provider-settings';

describe('auth-openai-oauth-lifecycle', () => {
	it('returns auth status from provider settings', () => {
		expect(OpenAIOAuthService.getAuthStatus()).toEqual({ authenticated: false, email: undefined });

		ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: Date.now() + 10 * 60_000,
			email: 'u@example.com'
		});
		expect(OpenAIOAuthService.getAuthStatus()).toEqual({ authenticated: true, email: 'u@example.com' });
	});

	it('returns null token when no credentials and logout removes tokens', async () => {
		expect(await OpenAIOAuthService.getValidToken()).toBeNull();

		ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: Date.now() + 10 * 60_000
		});
		OpenAIOAuthService.logout();
		expect(ProviderSettings.get('openai')).toBeUndefined();
		expect(await OpenAIOAuthService.getValidToken()).toBeNull();
	});

	it('returns existing credentials when not near expiry', async () => {
		const creds = {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: Date.now() + 10 * 60_000,
			email: 'x@example.com',
			accountId: 'acc'
		};
		ProviderSettings.upsertOAuth('openai', creds);
		const token = await OpenAIOAuthService.getValidToken();
		expect(token).toMatchObject(creds);
	});
});

describe('auth-openai-oauth login errors', () => {
	const pending = (sessionId: string) =>
		OpenAIPkceSessionStore.set(sessionId, { codeVerifier: 'v', state: 'v', expiresAt: Date.now() + 60_000 });

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reports an unreachable token endpoint instead of a generic exchange failure', async () => {
		pending('s1');
		const timeout = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: timeout })));
		const result = await OpenAIOAuthService.completeLogin('code', 's1');
		expect(result).toEqual({
			ok: false,
			error: 'Could not reach auth.openai.com (UND_ERR_CONNECT_TIMEOUT). Check your connection and sign in again.'
		});
	});

	it('reports the provider reason when the token endpoint rejects the code', async () => {
		pending('s2');
		const body = { error: { message: 'Could not validate your token. Please try signing in again.', code: 'token_expired' } };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 401 })));
		const result = await OpenAIOAuthService.completeLogin('code', 's2');
		expect(result).toEqual({
			ok: false,
			error: 'OpenAI rejected the sign-in (401): Could not validate your token. Please try signing in again.'
		});
	});
});
