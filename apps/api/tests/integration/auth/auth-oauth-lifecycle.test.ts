import { describe, expect, it } from 'vitest';

import { OAuth } from 'src/auth/oauth';
import { ProviderSettings } from 'src/database/provider-settings';

describe('auth-oauth-lifecycle', () => {
	it('returns unauthenticated status when row missing', () => {
		expect(OAuth.getAuthStatus()).toEqual({ authenticated: false });
	});

	it('returns authenticated status with email and can logout', () => {
		ProviderSettings.upsertOAuth('claude', {
			accessToken: 'access',
			refreshToken: 'refresh',
			expiresAt: Date.now() + 10 * 60_000,
			email: 'user@example.com'
		});
		expect(OAuth.getAuthStatus()).toEqual({ authenticated: true, email: 'user@example.com' });

		OAuth.logout();
		expect(ProviderSettings.get('claude')).toBeUndefined();
	});

	it('returns valid token when not expired and null when no row', async () => {
		const now = Date.now();
		ProviderSettings.upsertOAuth('claude', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: now + 10 * 60_000
		});

		const token = await OAuth.getValidToken();
		expect(token?.accessToken).toBe('a');

		ProviderSettings.remove('claude');
		expect(await OAuth.getValidToken()).toBeNull();
	});
});
