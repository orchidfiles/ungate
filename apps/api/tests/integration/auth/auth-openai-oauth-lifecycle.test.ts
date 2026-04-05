import { describe, expect, it } from 'vitest';

import { OpenAIOAuth } from 'src/auth/openai-oauth';
import { ProviderSettings } from 'src/database/provider-settings';

describe('auth-openai-oauth-lifecycle', () => {
	it('returns auth status from provider settings', () => {
		expect(OpenAIOAuth.getAuthStatus()).toEqual({ authenticated: false, email: undefined });

		ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: Date.now() + 10 * 60_000,
			email: 'u@example.com'
		});
		expect(OpenAIOAuth.getAuthStatus()).toEqual({ authenticated: true, email: 'u@example.com' });
	});

	it('returns null token when no credentials and logout removes tokens', async () => {
		expect(await OpenAIOAuth.getValidToken()).toBeNull();

		ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: Date.now() + 10 * 60_000
		});
		OpenAIOAuth.logout();
		expect(ProviderSettings.get('openai')).toBeUndefined();
		expect(await OpenAIOAuth.getValidToken()).toBeNull();
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
		const token = await OpenAIOAuth.getValidToken();
		expect(token).toMatchObject(creds);
	});
});
