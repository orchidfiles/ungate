import { beforeEach, describe, expect, it } from 'vitest';

import { getSqlite } from 'src/database';
import { ProviderSettings } from 'src/database/provider-settings';
import { useProviderSecretTransport } from 'src/security/provider-secrets';

import { useMemorySecretTransport, type MemorySecretTransport } from '../../helpers/memory-secret-transport';

function readLegacyColumns(provider: string): { access_token: string | null; refresh_token: string | null } | undefined {
	return getSqlite()
		.prepare('SELECT access_token, refresh_token FROM provider_settings WHERE provider = ?')
		.get(provider) as { access_token: string | null; refresh_token: string | null } | undefined;
}

describe('database-provider-settings', () => {
	let secrets: MemorySecretTransport;

	beforeEach(() => {
		secrets = useMemorySecretTransport();
	});

	it('upsert/get/remove api key lifecycle', async () => {
		await ProviderSettings.upsertApiKey('minimax', 'token-1', 'https://x');
		expect((await ProviderSettings.get('minimax'))?.accessToken).toBe('token-1');
		expect((await ProviderSettings.get('minimax'))?.baseUrl).toBe('https://x');

		await ProviderSettings.upsertApiKey('minimax', 'token-2');
		expect((await ProviderSettings.get('minimax'))?.accessToken).toBe('token-2');

		await ProviderSettings.remove('minimax');
		expect(await ProviderSettings.get('minimax')).toBeUndefined();
		expect(secrets.peek('minimax')).toBeUndefined();
	});

	it('stores oauth fields', async () => {
		await ProviderSettings.upsertOAuth('openai', {
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: 1000,
			email: 'u@example.com',
			accountId: 'acc'
		});

		const row = await ProviderSettings.get('openai');
		expect(row?.accessToken).toBe('a');
		expect(row?.refreshToken).toBe('r');
		expect(row?.expiresAt).toBe(1000);
		expect(row?.email).toBe('u@example.com');
		expect(row?.accountId).toBe('acc');
	});

	it('keeps credentials out of sqlite', async () => {
		await ProviderSettings.upsertOAuth('claude', { accessToken: 'access', refreshToken: 'refresh', expiresAt: 5 });
		await ProviderSettings.upsertApiKey('minimax', 'api-key');

		expect(readLegacyColumns('claude')).toEqual({ access_token: '', refresh_token: null });
		expect(readLegacyColumns('minimax')).toEqual({ access_token: '', refresh_token: null });
		expect(secrets.peek('claude')).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
		expect(secrets.peek('minimax')).toEqual({ accessToken: 'api-key', refreshToken: null });
	});

	it('reports metadata without touching the credential store', async () => {
		await ProviderSettings.upsertApiKey('minimax', 'api-key', 'https://china');
		useProviderSecretTransport(null);

		expect(ProviderSettings.getMetadata('minimax')?.baseUrl).toBe('https://china');
		// Fail closed: the base URL survives, the credential does not.
		expect(await ProviderSettings.hasCredentials('minimax')).toBe(false);
		expect((await ProviderSettings.get('minimax'))?.accessToken).toBe('');
	});

	it('refuses to persist a credential when the store is unavailable', async () => {
		useProviderSecretTransport(null);

		await expect(ProviderSettings.upsertApiKey('minimax', 'never-stored')).rejects.toThrow(/unavailable/);
		expect(ProviderSettings.getMetadata('minimax')).toBeUndefined();
	});

	it('migrates legacy plaintext credentials once and scrubs the columns', async () => {
		const sqlite = getSqlite();
		sqlite
			.prepare('INSERT INTO provider_settings (provider, access_token, refresh_token, expires_at, created_at) VALUES (?,?,?,?,?)')
			.run('claude', 'legacy-access', 'legacy-refresh', 9999, Date.now());
		sqlite
			.prepare('INSERT INTO provider_settings (provider, access_token, refresh_token, created_at) VALUES (?,?,?,?)')
			.run('ghost', 'orphan-access', null, Date.now());

		await ProviderSettings.migrateLegacySecrets();

		expect(secrets.peek('claude')).toEqual({ accessToken: 'legacy-access', refreshToken: 'legacy-refresh' });
		expect(readLegacyColumns('claude')).toEqual({ access_token: '', refresh_token: null });
		expect((await ProviderSettings.get('claude'))?.expiresAt).toBe(9999);

		// A row for a provider the API cannot serve keeps no plaintext either.
		expect(readLegacyColumns('ghost')).toEqual({ access_token: '', refresh_token: null });

		// Second pass is a no-op and must not overwrite a credential rotated since.
		await ProviderSettings.upsertOAuth('claude', { accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresAt: 1 });
		await ProviderSettings.migrateLegacySecrets();
		expect(secrets.peek('claude')).toEqual({ accessToken: 'rotated', refreshToken: 'rotated-refresh' });
	});
});
