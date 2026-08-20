import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuth } from 'src/auth/oauth';
import { ProviderSettings } from 'src/database/provider-settings';

import { useMemorySecretTransport, type MemorySecretTransport } from '../../helpers/memory-secret-transport';

describe('auth-oauth-lifecycle', () => {
	let secrets: MemorySecretTransport;

	beforeEach(() => {
		secrets = useMemorySecretTransport();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns unauthenticated status when row missing', async () => {
		expect(await OAuth.getAuthStatus()).toEqual({ authenticated: false });
	});

	it('returns authenticated status with email and can logout', async () => {
		await ProviderSettings.upsertOAuth('claude', {
			accessToken: 'access',
			refreshToken: 'refresh',
			expiresAt: Date.now() + 10 * 60_000,
			email: 'user@example.com'
		});

		expect(await OAuth.getAuthStatus()).toEqual({ authenticated: true, email: 'user@example.com' });

		await OAuth.logout();
		expect(await ProviderSettings.get('claude')).toBeUndefined();
		expect(secrets.peek('claude')).toBeUndefined();
	});

	it('returns valid token when not expired and null when no row', async () => {
		const now = Date.now();
		await ProviderSettings.upsertOAuth('claude', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: now + 10 * 60_000
		});

		const token = await OAuth.getValidToken();
		expect(token?.accessToken).toBe('a');

		await ProviderSettings.remove('claude');
		expect(await OAuth.getValidToken()).toBeNull();
	});

	it('persists refreshed tokens to the credential store and not to sqlite', async () => {
		await ProviderSettings.upsertOAuth('claude', {
			accessToken: 'stale',
			refreshToken: 'old-refresh',
			// Already inside the five-minute refresh window.
			expiresAt: Date.now() + 60_000,
			email: 'user@example.com'
		});

		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ access_token: 'fresh', refresh_token: 'new-refresh', expires_in: 3600 })
				});
			})
		);

		const token = await OAuth.getValidToken();

		expect(token?.accessToken).toBe('fresh');
		expect(secrets.peek('claude')).toEqual({ accessToken: 'fresh', refreshToken: 'new-refresh' });
		expect(await ProviderSettings.get('claude')).toMatchObject({ accessToken: 'fresh', refreshToken: 'new-refresh' });
		// The refreshed row is still usable; only the credential moved.
		expect(await OAuth.getAuthStatus()).toEqual({ authenticated: true, email: undefined });
	});
});
