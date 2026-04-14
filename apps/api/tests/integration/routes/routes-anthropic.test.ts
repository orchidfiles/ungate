import { afterEach, describe, expect, it, vi } from 'vitest';

import anthropicPlugin from 'src/routes/anthropic';
import { withPlugin } from '../test-harness';

const proxyRequestMock = vi.fn();

vi.mock('src/proxy/anthropic-client', () => ({
	proxyRequest: (...args: unknown[]) => proxyRequestMock(...args)
}));

describe('routes-anthropic', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('proxies stream body and headers', async () => {
		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('ok'));
				controller.close();
			}
		});
		proxyRequestMock.mockResolvedValueOnce({
			response: new Response(upstreamBody, {
				status: 201,
				headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'x-up': '1' }
			})
		});

		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'm', max_tokens: 10, messages: [] }
		});

		expect(response.statusCode).toBe(201);
		expect(response.headers['x-up']).toBe('1');
		expect(response.headers['content-encoding']).toBeUndefined();
		await app.close();
	});

	it('uses arrayBuffer fallback when body is missing', async () => {
		const noBodyResponse = new Response(null, { status: 202, headers: { 'x-up': 'x' } });
		proxyRequestMock.mockResolvedValueOnce({ response: noBodyResponse });

		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { authorization: 'Bearer secret' },
			payload: { model: 'm', max_tokens: 10, messages: [] }
		});

		expect(response.statusCode).toBe(202);
		await app.close();
	});

	it('returns 400 on thrown error', async () => {
		proxyRequestMock.mockRejectedValueOnce(new Error('upstream boom'));
		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { authorization: 'Bearer secret' },
			payload: { model: 'm', max_tokens: 10, messages: [] }
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error.message).toContain('upstream boom');
		await app.close();
	});
});
