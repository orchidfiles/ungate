import { describe, expect, it } from 'vitest';

import { ClientKeys } from 'src/database/client-keys';
import { clientKeyAuth } from 'src/plugins/auth';

import { createTestApp } from '../test-harness';

async function appWith(apiKey: string | undefined) {
	const app = createTestApp({ apiKey });
	app.get('/x', { onRequest: clientKeyAuth({ port: 0, apiKey, quietMode: true }) }, async (request) => ({
		clientId: request.clientId
	}));
	await app.ready();

	return app;
}

describe('plugins-auth', () => {
	it('is open with no client when no key exists at all', async () => {
		const app = await appWith(undefined);

		const response = await app.inject({ method: 'GET', url: '/x' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ clientId: null });
		await app.close();
	});

	it('accepts the settings key as client cursor, by bearer or x-api-key', async () => {
		const app = await appWith('secret');

		const bad = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': 'wrong' } });
		expect(bad.statusCode).toBe(403);
		expect(bad.json().error.type).toBe('authentication_error');

		const missing = await app.inject({ method: 'GET', url: '/x' });
		expect(missing.statusCode).toBe(403);

		const bearer = await app.inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer secret' } });
		expect(bearer.json()).toEqual({ clientId: 'cursor' });

		const header = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': 'secret' } });
		expect(header.json()).toEqual({ clientId: 'cursor' });
		await app.close();
	});

	it('accepts a minted key as its own client until it is revoked', async () => {
		const { client, key } = ClientKeys.create('coda-agent');
		const app = await appWith('secret');

		const ok = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': key } });
		expect(ok.statusCode).toBe(200);
		expect(ok.json()).toEqual({ clientId: client.id });

		ClientKeys.revoke(client.id);
		const revoked = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': key } });
		expect(revoked.statusCode).toBe(403);
		await app.close();
	});

	it('closes the routes once a minted key exists, even with no settings key', async () => {
		const { key } = ClientKeys.create('coda-agent');
		const app = await appWith(undefined);

		expect((await app.inject({ method: 'GET', url: '/x' })).statusCode).toBe(403);
		expect((await app.inject({ method: 'GET', url: '/x', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
		await app.close();
	});

	it('stays closed after the last minted key is revoked, with no settings key', async () => {
		const { client, key } = ClientKeys.create('coda-agent');
		const app = await appWith(undefined);

		ClientKeys.revoke(client.id);
		expect((await app.inject({ method: 'GET', url: '/x' })).statusCode).toBe(403);
		expect((await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': key } })).statusCode).toBe(403);
		await app.close();
	});
});
