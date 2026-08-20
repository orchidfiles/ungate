import { beforeEach, describe, expect, it } from 'vitest';

import { OpenAIOAuthService } from 'src/auth/openai/openai-oauth-service';
import { ProviderSettings } from 'src/database/provider-settings';

import { useMemorySecretTransport, type MemorySecretTransport } from '../../helpers/memory-secret-transport';

describe('auth-openai-oauth-lifecycle', () => {
	let secrets: MemorySecretTransport;

	beforeEach(() => {
		secrets = useMemorySecretTransport();
	});

	it('returns auth status from provider settings', async () => {
		expect(await OpenAIOAuthService.getAuthStatus()).toEqual({ authenticated: false, email: undefined });

		await ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: Date.now() + 10 * 60_000,
			email: 'u@example.com'
		});
		expect(await OpenAIOAuthService.getAuthStatus()).toEqual({ authenticated: true, email: 'u@example.com' });
	});

	it('returns null token when no credentials and logout removes tokens', async () => {
		expect(await OpenAIOAuthService.getValidToken()).toBeNull();

		await ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: Date.now() + 10 * 60_000
		});
		await OpenAIOAuthService.logout();
		expect(await ProviderSettings.get('openai')).toBeUndefined();
		expect(secrets.peek('openai')).toBeUndefined();
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
		await ProviderSettings.upsertOAuth('openai', creds);
		const token = await OpenAIOAuthService.getValidToken();
		expect(token).toMatchObject(creds);
	});
});
