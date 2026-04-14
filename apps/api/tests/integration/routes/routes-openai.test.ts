import { afterEach, describe, expect, it, vi } from 'vitest';

import openaiPlugin from 'src/routes/openai';

import { withPlugin } from '../test-harness';

const resolveForChatCompletionMock = vi.fn();
const proxyMiniMaxRequestMock = vi.fn();
const proxyOpenAIRequestMock = vi.fn();
const proxyRequestMock = vi.fn();
const requestsRecordMock = vi.fn();

vi.mock('src/database/model-mappings', () => ({
	ModelMappings: {
		resolveForChatCompletion: (...args: unknown[]) => resolveForChatCompletionMock(...args)
	}
}));

vi.mock('src/proxy/minimax-client', () => ({
	proxyMiniMaxRequest: (...args: unknown[]) => proxyMiniMaxRequestMock(...args)
}));

vi.mock('src/proxy/proxy-client', () => ({
	proxyOpenAIRequest: (...args: unknown[]) => proxyOpenAIRequestMock(...args)
}));

vi.mock('src/proxy/anthropic-client', () => ({
	proxyRequest: (...args: unknown[]) => proxyRequestMock(...args)
}));

vi.mock('src/database/requests', () => ({
	Requests: {
		record: (...args: unknown[]) => requestsRecordMock(...args)
	}
}));

vi.mock('src/adapter/openai-to-anthropic', () => ({
	openaiToAnthropic: vi.fn((body: Record<string, unknown>) => ({
		model: 'claude-sonnet-4-6',
		max_tokens: 1024,
		messages: body.messages ?? [],
		stream: body.stream ?? false
	}))
}));

function anthropicSseResponse(lines: string[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
			controller.close();
		}
	});

	return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('routes-openai', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('routes to minimax and returns non-stream response with headers', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce({ provider: 'minimax', upstreamModel: 'mini-up' });
		proxyMiniMaxRequestMock.mockResolvedValueOnce({
			response: new Response(JSON.stringify({ id: 'minimax-ok' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			}),
			context: {
				startTime: Date.now(),
				model: 'mini-up',
				source: 'minimax',
				reverseToolMapping: {},
				inputTokens: 1,
				outputTokens: 2,
				bodyJson: null
			}
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'minimax-chat', messages: [{ role: 'user', content: 'hi' }], stream: false }
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: 'minimax-ok' });
		expect(response.headers['x-request-id']).toBeTruthy();
		expect(response.headers['openai-processing-ms']).toBeTruthy();
		expect(response.headers['openai-version']).toBe('2020-10-01');
		expect(requestsRecordMock).toHaveBeenCalled();
		await app.close();
	});

	it('routes to openai provider and handles upstream error payload', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce({
			provider: 'openai',
			upstreamModel: 'gpt-up',
			reasoningBudget: null
		});
		proxyOpenAIRequestMock.mockResolvedValueOnce({
			response: new Response(JSON.stringify({ error: { message: 'upstream failed' } }), { status: 429 }),
			context: { startTime: Date.now(), model: 'gpt-up', source: 'openai', reverseToolMapping: {} }
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { authorization: 'Bearer secret' },
			payload: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: false }
		});

		expect(response.statusCode).toBe(429);
		expect(response.json().error.message).toBe('upstream failed');
		expect(response.headers['openai-version']).toBe('2020-10-01');
		await app.close();
	});

	it('routes to mapped openai and returns JSON success with reasoning forwarded upstream', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce({
			provider: 'openai',
			upstreamModel: 'gpt-up',
			reasoningBudget: 'high'
		});
		proxyOpenAIRequestMock.mockResolvedValueOnce({
			response: new Response(JSON.stringify({ id: 'chatcmpl-ok', choices: [{ message: { content: 'done' } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			}),
			context: {
				startTime: Date.now(),
				model: 'gpt-up',
				source: 'openai',
				reverseToolMapping: {},
				inputTokens: 3,
				outputTokens: 4
			}
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'gpt-alias', messages: [{ role: 'user', content: 'hi' }], stream: false }
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: 'chatcmpl-ok', choices: [{ message: { content: 'done' } }] });
		expect(response.headers['x-request-id']).toBeTruthy();
		expect(response.headers['openai-version']).toBe('2020-10-01');
		expect(requestsRecordMock).toHaveBeenCalled();
		expect(proxyOpenAIRequestMock).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'gpt-up',
				reasoning: { effort: 'high' }
			}),
			'openai'
		);
		await app.close();
	});

	it('routes to anthropic provider and maps successful response', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce(null);
		proxyRequestMock.mockResolvedValueOnce({
			response: new Response(
				JSON.stringify({
					id: 'msg_1',
					type: 'message',
					role: 'assistant',
					model: 'claude-sonnet-4-6',
					stop_reason: 'end_turn',
					stop_sequence: null,
					content: [{ type: 'text', text: 'hello' }],
					usage: { input_tokens: 1, output_tokens: 2 }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			),
			context: {
				startTime: Date.now(),
				model: 'claude-sonnet-4-6',
				source: 'claude',
				reverseToolMapping: {},
				inputTokens: 1,
				outputTokens: 2
			}
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'claude-4.6-sonnet', messages: [{ role: 'user', content: 'hello' }], stream: false }
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().object).toBe('chat.completion');
		expect(response.headers['x-request-id']).toBeTruthy();
		expect(requestsRecordMock).toHaveBeenCalled();
		await app.close();
	});

	it('routes to minimax by model name prefix when DB mapping is absent', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce(null);
		proxyMiniMaxRequestMock.mockResolvedValueOnce({
			response: new Response(JSON.stringify({ id: 'mm-prefix' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			}),
			context: {
				startTime: Date.now(),
				model: 'minimax-raw',
				source: 'minimax',
				reverseToolMapping: {},
				inputTokens: 0,
				outputTokens: 1,
				bodyJson: { id: 'mm-prefix' }
			}
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'minimax-by-name', messages: [{ role: 'user', content: 'hi' }], stream: false }
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: 'mm-prefix' });
		expect(proxyMiniMaxRequestMock).toHaveBeenCalledTimes(1);
		expect(proxyMiniMaxRequestMock.mock.calls[0][0]).toMatchObject({
			model: 'minimax-by-name',
			stream: false
		});
		await app.close();
	});

	it('routes to minimax and maps upstream HTTP error when body is not JSON object', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce({ provider: 'minimax', upstreamModel: 'mini-up' });
		proxyMiniMaxRequestMock.mockResolvedValueOnce({
			response: new Response(null, { status: 502 }),
			context: { startTime: Date.now(), model: 'mini-up', source: 'minimax', reverseToolMapping: {} }
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'minimax-chat', messages: [{ role: 'user', content: 'hi' }], stream: false }
		});

		expect(response.statusCode).toBe(502);
		expect(response.json().error.message).toBe('HTTP 502');
		expect(requestsRecordMock).toHaveBeenCalled();
		await app.close();
	});

	it('routes to claude and sanitizes model id prefix in error message', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce(null);
		proxyRequestMock.mockResolvedValueOnce({
			response: new Response(
				JSON.stringify({
					error: { message: 'invalid model: x-sonnet-9', type: 'invalid_request_error' }
				}),
				{ status: 400, headers: { 'content-type': 'application/json' } }
			),
			context: { startTime: Date.now(), model: 'claude-sonnet-4-6', source: 'claude', reverseToolMapping: {} }
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'claude-4.6-sonnet', messages: [{ role: 'user', content: 'hello' }], stream: false }
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error.message).toBe('invalid model: sonnet-9');
		expect(response.json().error.type).toBe('invalid_request_error');
		await app.close();
	});

	it('routes to mapped openai with streaming passthrough', async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.close();
			}
		});
		resolveForChatCompletionMock.mockReturnValueOnce({
			provider: 'openai',
			upstreamModel: 'gpt-up',
			reasoningBudget: null
		});
		proxyOpenAIRequestMock.mockResolvedValueOnce({
			response: new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }
			}),
			context: { startTime: Date.now(), model: 'gpt-up', source: 'openai', reverseToolMapping: {} }
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: true }
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers['content-type']).toContain('text/event-stream');
		await app.close();
	});

	it('routes to minimax with streaming and records usage', async () => {
		const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			}
		});
		resolveForChatCompletionMock.mockReturnValueOnce({ provider: 'minimax', upstreamModel: 'mini-up' });
		proxyMiniMaxRequestMock.mockResolvedValueOnce({
			response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
			context: { startTime: Date.now(), model: 'mini-up', source: 'minimax', reverseToolMapping: {} }
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'minimax-chat', messages: [{ role: 'user', content: 'hi' }], stream: true }
		});

		expect(response.statusCode).toBe(200);
		expect(requestsRecordMock).toHaveBeenCalled();
		await app.close();
	});

	it('routes to claude with streaming via OpenAI stream mapper', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce(null);
		proxyRequestMock.mockResolvedValueOnce({
			response: anthropicSseResponse([
				'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
				'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"streamed"}}',
				'data: {"type":"message_delta","usage":{"output_tokens":2}}',
				'data: {"type":"message_stop"}'
			]),
			context: { startTime: Date.now(), model: 'claude-sonnet-4-6', source: 'claude', reverseToolMapping: {} }
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'claude-4.6-sonnet', messages: [{ role: 'user', content: 'hello' }], stream: true }
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers['content-type']).toContain('text/event-stream');
		expect(requestsRecordMock).toHaveBeenCalled();
		await app.close();
	});

	it('returns 400 on handler exception', async () => {
		resolveForChatCompletionMock.mockImplementationOnce(() => {
			throw new Error('boom');
		});

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: false }
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error.type).toBe('invalid_request_error');
		await app.close();
	});
});
