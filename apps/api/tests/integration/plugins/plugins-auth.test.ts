import { describe, expect, it } from 'vitest';

import { ADMIN_KEY_HEADER } from '@ungate/shared';
import { adminKeyAuth, apiKeyAuth } from 'src/plugins/auth';

import { createTestApp, TEST_ADMIN_KEY } from '../test-harness';

const ADMIN_CONFIG = { port: 0, adminApiKey: TEST_ADMIN_KEY, quietMode: true };

describe('plugins-auth', () => {
	it('fails closed on proxy routes when no api key is configured', async () => {
		// These routes are reachable through the public tunnel; an absent key must lock them,
		// never open them to anyone who knows the URL.
		const app = createTestApp({});
		app.get('/x', { onRequest: apiKeyAuth(ADMIN_CONFIG) }, async () => ({ ok: true }));
		await app.ready();

		const anonymous = await app.inject({ method: 'GET', url: '/x' });
		expect(anonymous.statusCode).toBe(403);
		expect(anonymous.json().error.type).toBe('authentication_error');

		// Nor can a caller authenticate by guessing that the configured key is blank.
		const blankBearer = await app.inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer ' } });
		expect(blankBearer.statusCode).toBe(403);

		const blankHeader = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': '' } });
		expect(blankHeader.statusCode).toBe(403);
		await app.close();
	});

	it('fails closed on proxy routes when the configured api key is blank', async () => {
		const app = createTestApp({ apiKey: '' });
		app.get('/x', { onRequest: apiKeyAuth({ ...ADMIN_CONFIG, apiKey: '' }) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': '' } });
		expect(response.statusCode).toBe(403);
		await app.close();
	});

	it('rejects request with invalid key and accepts valid key', async () => {
		const app = createTestApp({ apiKey: 'secret' });
		app.get('/x', { onRequest: apiKeyAuth({ ...ADMIN_CONFIG, apiKey: 'secret' }) }, async () => ({ ok: true }));
		await app.ready();

		const bad = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': 'wrong' } });
		expect(bad.statusCode).toBe(403);
		expect(bad.json().error.type).toBe('authentication_error');

		const good = await app.inject({
			method: 'GET',
			url: '/x',
			headers: { authorization: 'Bearer secret' }
		});
		expect(good.statusCode).toBe(200);
		await app.close();
	});

	it('rejects an authorization header that is not a bearer token', async () => {
		const app = createTestApp({ apiKey: 'secret' });
		app.get('/x', { onRequest: apiKeyAuth({ ...ADMIN_CONFIG, apiKey: 'secret' }) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({ method: 'GET', url: '/x', headers: { authorization: 'Basic secret' } });
		expect(response.statusCode).toBe(403);
		await app.close();
	});

	it('rejects an admin request with no key at all', async () => {
		const app = createTestApp({});
		app.get('/x', { onRequest: adminKeyAuth(ADMIN_CONFIG) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({ method: 'GET', url: '/x' });
		expect(response.statusCode).toBe(403);
		expect(response.json().error.message).toBe('Unauthorized: Invalid admin key');
		await app.close();
	});

	it('rejects an admin request carrying the wrong key', async () => {
		const app = createTestApp({});
		app.get('/x', { onRequest: adminKeyAuth(ADMIN_CONFIG) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({
			method: 'GET',
			url: '/x',
			headers: { [ADMIN_KEY_HEADER]: 'a'.repeat(64) }
		});
		expect(response.statusCode).toBe(403);
		await app.close();
	});

	it('rejects an admin request that presents the proxy key instead', async () => {
		const app = createTestApp({});
		app.get('/x', { onRequest: adminKeyAuth({ ...ADMIN_CONFIG, apiKey: 'proxy-key' }) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({
			method: 'GET',
			url: '/x',
			headers: { authorization: 'Bearer proxy-key', 'x-api-key': 'proxy-key' }
		});
		expect(response.statusCode).toBe(403);
		await app.close();
	});

	it('accepts an admin request carrying the correct key', async () => {
		const app = createTestApp({});
		app.get('/x', { onRequest: adminKeyAuth(ADMIN_CONFIG) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({
			method: 'GET',
			url: '/x',
			headers: { [ADMIN_KEY_HEADER]: TEST_ADMIN_KEY }
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ ok: true });
		await app.close();
	});

	it('fails closed when the admin key is missing from config', async () => {
		const app = createTestApp({});
		app.get('/x', { onRequest: adminKeyAuth({ port: 0, adminApiKey: '', quietMode: true }) }, async () => ({ ok: true }));
		await app.ready();

		const empty = await app.inject({ method: 'GET', url: '/x' });
		expect(empty.statusCode).toBe(403);

		const alsoEmpty = await app.inject({ method: 'GET', url: '/x', headers: { [ADMIN_KEY_HEADER]: '' } });
		expect(alsoEmpty.statusCode).toBe(403);
		await app.close();
	});

	it('rejects a request that sends the admin key header twice', async () => {
		const app = createTestApp({});
		app.get('/x', { onRequest: adminKeyAuth(ADMIN_CONFIG) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({
			method: 'GET',
			url: '/x',
			headers: { [ADMIN_KEY_HEADER]: ['wrong', TEST_ADMIN_KEY] }
		});
		expect(response.statusCode).toBe(403);
		await app.close();
	});
});
