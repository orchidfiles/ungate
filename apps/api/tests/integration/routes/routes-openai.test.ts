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

describe('routes-openai', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('routes to minimax and returns non-stream response with headers', async () => {
		resolveForChatCompletionMock.mockReturnValueOnce({ provider: 'minimax', upstreamModel: 'mini-up' });
		proxyMiniMaxRequestMock.mockResolvedValueOnce({
			response: new Response(JSON.stringify({ id: 'minimax-ok' }), { status: 200, headers: { 'content-type': 'application/json' } }),
			context: { startTime: Date.now(), model: 'mini-up', source: 'minimax', inputTokens: 1, outputTokens: 2, bodyJson: null }
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
			context: { startTime: Date.now(), model: 'gpt-up', source: 'openai' }
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
			context: { startTime: Date.now(), model: 'claude-sonnet-4-6', source: 'claude', inputTokens: 1, outputTokens: 2 }
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
