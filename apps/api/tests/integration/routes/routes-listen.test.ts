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
});
