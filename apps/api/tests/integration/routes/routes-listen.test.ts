import { request } from 'node:http';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { listenOnAll } from 'src/server';

import type { AddressInfo } from 'node:net';

function get(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host, port, path, method: 'GET' }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

describe('listenOnAll', () => {
	it('serves the same routes on every address, each request seeing its own peer', async () => {
		const app = Fastify({ logger: false });
		app.get('/peer', async (req) => ({ peer: req.socket.remoteAddress }));

		// Port 0 on the first listener, then the same port on the second: pick a free one first.
		const probe = Fastify();
		await probe.listen({ port: 0, host: '127.0.0.1' });
		const port = (probe.server.address() as AddressInfo).port;
		await probe.close();

		await listenOnAll(app, ['127.0.0.1', '::1'], port);

		expect(await get('127.0.0.1', port, '/peer')).toEqual({ status: 200, body: JSON.stringify({ peer: '127.0.0.1' }) });
		expect(await get('::1', port, '/peer')).toEqual({ status: 200, body: JSON.stringify({ peer: '::1' }) });

		await app.close();
		await expect(get('::1', port, '/peer')).rejects.toThrow();
	});

	it('serves the other addresses while one is not on this machine, and stops retrying on close', async () => {
		const app = Fastify({ logger: false });
		app.decorate('config', { port: 0, hosts: [], apiKey: 'k', quietMode: true });
		await registerRoutes(app);

		const probe = Fastify();
		await probe.listen({ port: 0, host: '127.0.0.1' });
		const port = (probe.server.address() as AddressInfo).port;
		await probe.close();

		// TEST-NET-1: never assigned here, so listening on it fails with EADDRNOTAVAIL.
		await listenOnAll(app, ['127.0.0.1', '192.0.2.1'], port, 10);
		expect(await get('127.0.0.1', port, '/health')).toBe(200);

		await new Promise((resolve) => setTimeout(resolve, 50));
		await app.close();
		await expect(get('127.0.0.1', port, '/health')).rejects.toThrow();
	});

	it('fails when a further address is taken', async () => {
		const app = Fastify({ logger: false });
		app.decorate('config', { port: 0, hosts: [], apiKey: 'k', quietMode: true });
		await registerRoutes(app);

		const holder = Fastify();
		await holder.listen({ port: 0, host: '::1' });
		const port = (holder.server.address() as AddressInfo).port;

		await expect(listenOnAll(app, ['127.0.0.1', '::1'], port)).rejects.toMatchObject({ code: 'EADDRINUSE' });

		await app.close();
		await holder.close();
	});
});
