import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { ClientKeys } from 'src/database/client-keys';
import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import { drainServer, registerRoutes } from 'src/server';
import { AnthropicSseTap } from 'src/streaming/anthropic-sse-tap';

import type { SubscriptionProvider } from '@ungate/shared';

async function server(apiKey = 'settings-key') {
	const app = Fastify({ logger: false });
	app.decorate('config', { port: 0, apiKey, quietMode: true });
	await registerRoutes(app);
	await app.ready();

	return app;
}

function add(provider: SubscriptionProvider, user: string): OAuthAccountRow {
	return OAuthAccounts.saveLogin(
		provider,
		{ accessToken: `token-${user}`, refreshToken: `refresh-${user}`, expiresAt: Date.now() + 3_600_000 },
		{ providerUserId: user, providerAccountId: provider === 'openai' ? `ws-${user}` : null, email: `${user}@example.com` },
		OAuthAccounts.list(provider)
	);
}

const REMOTE = { remoteAddress: '10.231.0.2' };

describe('GET /v1/pool', () => {
	it('reports per-provider counts and the earliest reset, with no account identities', async () => {
		add('claude', 'a');
		const b = add('claude', 'b');
		const c = add('claude', 'c');
		const d = add('claude', 'd');
		add('openai', 'x');
		const reset = Date.now() + 3_600_000;
		OAuthAccounts.markCooldown(b.id, reset + 60_000, 'anthropic_usage_limit', false);
		OAuthAccounts.markCooldown(c.id, reset, 'anthropic_usage_limit', false);
		OAuthAccounts.markNeedsLogin(d.id, d.credentialVersion, 'refresh_rejected');
		const { key } = ClientKeys.create('coda-agent');
		const app = await server();

		const response = await app.inject({ method: 'GET', url: '/v1/pool', headers: { authorization: `Bearer ${key}` }, ...REMOTE });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			providers: [
				{ provider: 'claude', eligible: 1, cooling_down: 2, needs_login: 1, earliest_reset: new Date(reset).toISOString() },
				{ provider: 'chatgpt', eligible: 1, cooling_down: 0, needs_login: 0, earliest_reset: null }
			]
		});
		expect(response.body).not.toContain('example.com');
		expect(response.body).not.toContain(b.id);
		await app.close();
	});

	it('omits providers with no accounts', async () => {
		add('openai', 'x');
		const { key } = ClientKeys.create('coda-agent');
		const app = await server();

		const response = await app.inject({ method: 'GET', url: '/v1/pool', headers: { authorization: `Bearer ${key}` }, ...REMOTE });

		expect(response.json()).toEqual({
			providers: [{ provider: 'chatgpt', eligible: 1, cooling_down: 0, needs_login: 0, earliest_reset: null }]
		});
		await app.close();
	});

	it('is guarded like the model routes', async () => {
		const app = await server();

		const missing = await app.inject({ method: 'GET', url: '/v1/pool', ...REMOTE });
		expect(missing.statusCode).toBe(403);
		const wrong = await app.inject({ method: 'GET', url: '/v1/pool', headers: { authorization: 'Bearer ug_nope' }, ...REMOTE });
		expect(wrong.statusCode).toBe(403);
		await app.close();
	});
});

describe('drainServer', () => {
	it('ends a stream still open after the drain window with its terminal error event', async () => {
		const app = Fastify({ logger: false });
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
			}
		});
		app.get('/stream', (_request, reply) =>
			reply.header('content-type', 'text/event-stream').send(AnthropicSseTap.observe(upstream, { onEnd: () => undefined }))
		);
		await app.listen({ port: 0, host: '127.0.0.1' });
		const address = app.server.address();
		const port = typeof address === 'object' && address ? address.port : 0;

		const response = await fetch(`http://127.0.0.1:${port}/stream`);
		const body = response.text();
		await drainServer(app, 20);
		const text = await body;

		expect(text).toContain('event: ping');
		expect(text).toContain('event: error');
		expect(text).toContain('Ungate is restarting');
	});

	it('lets a stream that finishes inside the drain window complete untouched', async () => {
		const app = Fastify({ logger: false });
		let finish: (() => void) | undefined;
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
				finish = () => {
					controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
					controller.close();
				};
			}
		});
		app.get('/stream', (_request, reply) =>
			reply.header('content-type', 'text/event-stream').send(AnthropicSseTap.observe(upstream, { onEnd: () => undefined }))
		);
		await app.listen({ port: 0, host: '127.0.0.1' });
		const address = app.server.address();
		const port = typeof address === 'object' && address ? address.port : 0;

		const response = await fetch(`http://127.0.0.1:${port}/stream`);
		const body = response.text();
		const drained = drainServer(app, 5_000);
		setTimeout(() => finish?.(), 20);
		await drained;
		const text = await body;

		expect(text).toContain('message_stop');
		expect(text).not.toContain('event: error');
	});
});
