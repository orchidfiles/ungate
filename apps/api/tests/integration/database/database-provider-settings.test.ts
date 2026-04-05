import { describe, expect, it } from 'vitest';

import { ProviderSettings } from 'src/database/provider-settings';

describe('database-provider-settings', () => {
	it('upsert/get/remove api key lifecycle', () => {
		ProviderSettings.upsertApiKey('minimax', 'token-1', 'https://x');
		expect(ProviderSettings.get('minimax')?.accessToken).toBe('token-1');
		expect(ProviderSettings.get('minimax')?.baseUrl).toBe('https://x');

		ProviderSettings.upsertApiKey('minimax', 'token-2');
		expect(ProviderSettings.get('minimax')?.accessToken).toBe('token-2');

		ProviderSettings.remove('minimax');
		expect(ProviderSettings.get('minimax')).toBeUndefined();
	});

	it('stores oauth fields', () => {
		ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: 1000,
			email: 'user@example.com',
			accountId: 'acc'
		});

		const row = ProviderSettings.get('openai');
		expect(row?.accessToken).toBe('a');
		expect(row?.refreshToken).toBe('r');
		expect(row?.expiresAt).toBe(1000);
		expect(row?.email).toBe('user@example.com');
		expect(row?.accountId).toBe('acc');
	});
});
