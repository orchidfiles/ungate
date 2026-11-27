import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSqlite } from 'src/database';
import { ClientKeys } from 'src/database/client-keys';
import { Requests } from 'src/database/requests';
import { registerRoutes } from 'src/server';

const proxyRequestMock = vi.fn();

vi.mock('src/proxy/anthropic-client', () => ({
	proxyRequest: (...args: unknown[]) => proxyRequestMock(...args)
}));

/** The real route table from `startServer`, so the admin scope is what production registers. */
async function server(apiKey = 'settings-key') {
	const app = Fastify({ logger: false });
	app.decorate('config', { port: 0, apiKey, quietMode: true });
	await registerRoutes(app);
	await app.ready();

	return app;
}

const REMOTE = { remoteAddress: '10.231.0.2' };

describe('routes-clients', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('lists the seeded cursor client and mints, renames and revokes others', async () => {
		const app = await server();

		const initial = await app.inject({ method: 'GET', url: '/clients' });
		expect(initial.json().clients).toEqual([expect.objectContaining({ id: 'cursor', kind: 'settings', revokedAt: null })]);

		const created = await app.inject({ method: 'POST', url: '/clients', payload: { label: 'coda-agent' } });
		expect(created.statusCode).toBe(200);
		const { client, key, clients } = created.json();
		expect(key).toMatch(/^ug_/);
		expect(client).toEqual(expect.objectContaining({ kind: 'minted', label: 'coda-agent' }));
		expect(clients).toHaveLength(2);
		expect(JSON.stringify(clients)).not.toContain(key);

		const stored = getSqlite().prepare('SELECT key_hash FROM client_keys WHERE id = ?').get(client.id) as { key_hash: string };
		expect(stored.key_hash).not.toContain(key);

		const renamed = await app.inject({ method: 'PATCH', url: `/clients/${client.id}`, payload: { label: 'agent' } });
		expect(renamed.json().clients.find((c: { id: string }) => c.id === client.id).label).toBe('agent');

		const revoked = await app.inject({ method: 'POST', url: `/clients/${client.id}/revoke` });
		expect(revoked.json().clients.find((c: { id: string }) => c.id === client.id).revokedAt).toEqual(expect.any(Number));

		const settings = await app.inject({ method: 'POST', url: '/clients/cursor/revoke' });
		expect(settings.statusCode).toBe(409);

		const missing = await app.inject({ method: 'POST', url: '/clients/nope/revoke' });
		expect(missing.statusCode).toBe(404);

		const blank = await app.inject({ method: 'POST', url: '/clients', payload: { label: '  ' } });
		expect(blank.statusCode).toBe(400);
		await app.close();
	});

	it('refuses admin routes to anything but direct loopback, whatever key is sent', async () => {
		const { key } = ClientKeys.create('coda-agent');
		const app = await server();

		for (const url of ['/settings', '/clients', '/analytics', '/analytics/clients', '/auth/claude/accounts', '/auth/cursor/status']) {
			for (const headers of [{}, { 'x-api-key': key }, { authorization: 'Bearer settings-key' }]) {
				const remote = await app.inject({ method: 'GET', url, headers, ...REMOTE });
				expect(remote.statusCode, `${url} from the container`).toBe(403);
			}

			const tunnelled = await app.inject({ method: 'GET', url, headers: { 'cf-connecting-ip': '1.2.3.4', 'x-api-key': key } });
			expect(tunnelled.statusCode, `${url} through the tunnel`).toBe(403);
		}

		const mint = await app.inject({ method: 'POST', url: '/clients', payload: { label: 'x' }, headers: { 'x-api-key': key }, ...REMOTE });
		expect(mint.statusCode).toBe(403);

		expect((await app.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(200);
		expect((await app.inject({ method: 'GET', url: '/health', ...REMOTE })).statusCode).toBe(200);
		await app.close();
	});

	it('lets a minted key reach model routes from the container', async () => {
		const { key } = ClientKeys.create('coda-agent');
		proxyRequestMock.mockResolvedValueOnce({ response: new Response('{}', { status: 200 }), context: {} });
		const app = await server();

		const refused = await app.inject({ method: 'POST', url: '/v1/messages', payload: { model: 'm', max_tokens: 1, messages: [] }, ...REMOTE });
		expect(refused.statusCode).toBe(403);

		const ok = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { 'x-api-key': key },
			payload: { model: 'm', max_tokens: 1, messages: [] },
			...REMOTE
		});
		expect(ok.statusCode).toBe(200);
		await app.close();
	});

	it('names the client of a presented key on /v1/client, and refuses an unknown or revoked one', async () => {
		const { client, key } = ClientKeys.create('coda-agent');
		const app = await server();

		const mine = await app.inject({ method: 'GET', url: '/v1/client', headers: { authorization: `Bearer ${key}` }, ...REMOTE });
		expect(mine.statusCode).toBe(200);
		expect(mine.json()).toEqual({ client: { id: client.id, label: 'coda-agent' } });

		const cursor = await app.inject({ method: 'GET', url: '/v1/client', headers: { 'x-api-key': 'settings-key' } });
		expect(cursor.json()).toEqual({ client: { id: 'cursor', label: 'cursor' } });

		const unknown = await app.inject({ method: 'GET', url: '/v1/client', headers: { 'x-api-key': 'ug_nope' }, ...REMOTE });
		expect(unknown.statusCode).toBe(403);

		ClientKeys.revoke(client.id);
		const revoked = await app.inject({ method: 'GET', url: '/v1/client', headers: { 'x-api-key': key }, ...REMOTE });
		expect(revoked.statusCode).toBe(403);
		await app.close();
	});

	it('reports usage per client, with unattributed rows grouped apart', async () => {
		const { client } = ClientKeys.create('coda-agent');
		const base = { model: 'claude-opus-4-8', source: 'claude' as const, stream: true, latencyMs: 1 };
		Requests.record({ ...base, inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, clientId: client.id });
		Requests.record({ ...base, inputTokens: 50, outputTokens: 5, clientId: client.id });
		Requests.record({ ...base, source: 'error', inputTokens: 0, outputTokens: 0, clientId: 'cursor' });
		Requests.record({ ...base, inputTokens: 7, outputTokens: 1 });

		const app = await server();
		const response = await app.inject({ method: 'GET', url: '/analytics/clients?period=day' });
		const rows = response.json().clients;

		expect(rows[0]).toEqual(
			expect.objectContaining({
				clientId: client.id,
				label: 'coda-agent',
				requests: 2,
				inputTokens: 150,
				outputTokens: 15,
				cacheReadTokens: 40,
				errors: 0
			})
		);
		expect(rows).toContainEqual(expect.objectContaining({ clientId: 'cursor', label: 'cursor', requests: 1, errors: 1 }));
		expect(rows).toContainEqual(expect.objectContaining({ clientId: null, label: null, requests: 1, inputTokens: 7 }));
		await app.close();
	});
});
