import { afterEach, describe, expect, it, vi } from 'vitest';

import { Requests } from 'src/database/requests';
import anthropicPlugin from 'src/routes/anthropic';

import { withPlugin } from '../test-harness';

import type { RequestContext } from 'src/types/proxy';

const proxyRequestMock = vi.fn();

vi.mock('src/proxy/anthropic-client', () => ({
	proxyRequest: (...args: unknown[]) => proxyRequestMock(...args)
}));

function context(): RequestContext {
	return {
		model: 'claude-x',
		source: 'claude',
		startTime: Date.now(),
		reverseToolMapping: {},
		telemetry: { accountId: 'acct-a' }
	};
}

function sse(events: unknown[]): string {
	return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const CLAUDE_CODE = {
	'user-agent': 'claude-cli/2.1.0 (external, cli)',
	'x-claude-code-session-id': 'session-1',
	'anthropic-beta': 'claude-code-20250219',
	'x-app': 'cli'
};

describe('routes-anthropic', () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it('passes a streamed body through unchanged and records its usage once', async () => {
		const record = vi.spyOn(Requests, 'record').mockReturnValue(1);
		const text = sse([
			{
				type: 'message_start',
				message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 } }
			},
			{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } },
			{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
			{ type: 'message_stop' }
		]);
		proxyRequestMock.mockResolvedValueOnce({
			response: new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' } }),
			context: context()
		});

		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { 'x-api-key': 'secret', ...CLAUDE_CODE },
			payload: { model: 'claude-x', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] }
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toBe(text);
		expect(response.headers['content-encoding']).toBeUndefined();

		const [, , caller] = proxyRequestMock.mock.calls[0] as [string, unknown, { kind: string; headers: Record<string, string> }];
		expect(caller.kind).toBe('claude-code');
		expect(caller.headers['anthropic-beta']).toBe('claude-code-20250219');
		expect(caller.headers['x-api-key']).toBeUndefined();

		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0][0]).toMatchObject({
			accountId: 'acct-a',
			stream: true,
			inputTokens: 115,
			outputTokens: 42,
			cacheReadTokens: 100,
			cacheCreationTokens: 5,
			stopReason: 'tool_use',
			toolNames: ['Bash'],
			error: null
		});
		expect(record.mock.calls[0][0].sessionKey).toEqual(expect.any(String));
		await app.close();
	});

	it('treats other callers as translated and records upstream errors', async () => {
		const record = vi.spyOn(Requests, 'record').mockReturnValue(1);
		proxyRequestMock.mockResolvedValueOnce({
			response: new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
				status: 529,
				headers: { 'content-type': 'application/json' }
			}),
			context: context()
		});

		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { authorization: 'Bearer secret' },
			payload: { model: 'claude-x', max_tokens: 10, messages: [] }
		});

		expect(response.statusCode).toBe(529);
		expect(response.json().error.message).toBe('busy');
		expect(proxyRequestMock.mock.calls[0][2]).toEqual({ kind: 'translated' });
		expect(record.mock.calls[0][0]).toMatchObject({ source: 'error', stream: false, stopReason: 'error', error: 'busy' });
		await app.close();
	});

	it('counts tokens on the pool without recording usage', async () => {
		const record = vi.spyOn(Requests, 'record').mockReturnValue(1);
		proxyRequestMock.mockResolvedValueOnce({
			response: new Response(JSON.stringify({ input_tokens: 7 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			}),
			context: context()
		});

		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages/count_tokens',
			headers: { 'x-api-key': 'secret', ...CLAUDE_CODE },
			payload: { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ input_tokens: 7 });
		expect(proxyRequestMock.mock.calls[0][0]).toBe('/v1/messages/count_tokens');
		expect(record).not.toHaveBeenCalled();
		await app.close();
	});

	it('refuses a request without a key', async () => {
		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			payload: { model: 'm', max_tokens: 1, messages: [] }
		});

		expect(response.statusCode).toBe(403);
		expect(proxyRequestMock).not.toHaveBeenCalled();
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
