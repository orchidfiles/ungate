import { beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
vi.mock('src/database/requests', () => ({ Requests: { record: (...args: unknown[]) => record(...args) } }));

const { CursorResponseAccumulator, CursorStreamHandler } = await import('src/streaming/cursor-stream-handler');
const { CompletionErrorMapper, CompletionModelRouting } = await import('src/orchestration/openai');
const { buildRepairRequest, CursorChatHandler } = await import('src/orchestration/openai/provider-handlers/cursor-chat-handler');

import type { CursorBridgeEventBody, CursorInferenceRequest, ModelMappingConfig, RequestTelemetry } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { CursorBridgeClient } from 'src/proxy/cursor-bridge-client';
import type { RepairRound } from 'src/streaming/cursor-stream-handler';
import type { OpenAITool } from 'src/types/openai';

const tools: OpenAITool[] = [
	{
		type: 'function',
		function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
	}
];

// Sanitized frame sequences recorded from the RunInference probes.
const GROK_TOOL_CALL: CursorBridgeEventBody[] = [
	{ kind: 'thinking', text: 'Need to read the file.' },
	{ kind: 'toolCall', toolCallId: 'call_g1', toolName: 'Read', args: '{"path":"README.md"}', isComplete: true, toolIndex: 0 },
	{
		kind: 'usage',
		usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 0, reasoningTokens: 12 }
	},
	{ kind: 'end', error: null }
];
const COMPOSER_DELTA_ARGS: CursorBridgeEventBody[] = [
	{ kind: 'text', text: 'Reading.' },
	{ kind: 'toolCall', toolCallId: 'call_c1', toolName: 'Read', args: '{"pa', isComplete: false, toolIndex: 0 },
	{ kind: 'toolCall', toolCallId: 'call_c1', toolName: 'Read', args: 'th":"a.ts"}', isComplete: false, toolIndex: 0 },
	{ kind: 'toolCall', toolCallId: 'call_c1', toolName: 'Read', args: '{"path":"a.ts"}', isComplete: true, toolIndex: 0 },
	{ kind: 'end', error: null }
];

async function* from(events: CursorBridgeEventBody[]): AsyncGenerator<CursorBridgeEventBody> {
	for (const event of events) yield await Promise.resolve(event);
}

const telemetry = {} as RequestTelemetry;
const options = (events: CursorBridgeEventBody[], signal?: AbortSignal) => ({
	events: from(events),
	streamId: 's1',
	modelName: 'cursor-grok-4.7-low-fast',
	upstreamModel: 'grok-4.7-low-fast',
	tools,
	startTime: Date.now(),
	telemetry,
	signal
});

async function readSse(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
	const text = await new Response(stream).text();

	return text
		.split('\n\n')
		.map((line) => line.replace(/^data: /, '').trim())
		.filter((line) => line && line !== '[DONE]')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => record.mockClear());

describe('CursorResponseAccumulator', () => {
	it('emits a Grok complete-args tool call once', () => {
		const acc = new CursorResponseAccumulator('grok', tools);
		const deltas = GROK_TOOL_CALL.flatMap((event) => acc.apply(event));
		expect(deltas).toEqual([
			{ reasoning_content: 'Need to read the file.' },
			{
				tool_calls: [{ index: 0, id: 'call_g1', type: 'function', function: { name: 'Read', arguments: '{"path":"README.md"}' } }]
			}
		]);
		expect(acc.finishReason()).toBe('tool_calls');
		expect(acc.stopReason(false)).toBe('tool_use');
	});

	it('streams Composer argument deltas without resending bytes', () => {
		const acc = new CursorResponseAccumulator('composer', tools);
		const deltas = COMPOSER_DELTA_ARGS.flatMap((event) => acc.apply(event));
		const args = deltas
			.flatMap((delta) => ('tool_calls' in delta ? delta.tool_calls : []))
			.map((call) => call.function.arguments ?? '')
			.join('');
		expect(args).toBe('{"path":"a.ts"}');
		expect(acc.toolCalls).toEqual([
			{ id: 'call_c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }
		]);
	});

	it('maps the output token limit to length', () => {
		const acc = new CursorResponseAccumulator('grok', tools);
		acc.apply({ kind: 'text', text: 'partial' });
		acc.apply({
			kind: 'end',
			error: { kind: 'upstream', message: 'limit', code: 'INFERENCE_STREAM_ERROR_TYPE_OUTPUT_TOKEN_LIMIT' }
		});
		expect(acc.finishReason()).toBe('length');
		expect(acc.stopReason(false)).toBe('max_tokens');
	});
});

describe('CursorStreamHandler', () => {
	it('streams OpenAI chunks with usage and records one row', async () => {
		const { stream } = CursorStreamHandler.createStreamResponse(options(GROK_TOOL_CALL));
		const chunks = await readSse(stream as ReadableStream<Uint8Array>);
		const finish = chunks.find((chunk) => (chunk.choices as { finish_reason: string | null }[])[0]?.finish_reason);
		expect((finish?.choices as { finish_reason: string }[])[0].finish_reason).toBe('tool_calls');
		const usageChunk = chunks.at(-1) as { usage: Record<string, unknown> };
		expect(usageChunk.usage).toMatchObject({
			prompt_tokens: 2000,
			completion_tokens: 40,
			prompt_tokens_details: { cached_tokens: 800 },
			completion_tokens_details: { reasoning_tokens: 12 }
		});
		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0][0]).toMatchObject({
			source: 'cursor',
			stopReason: 'tool_use',
			toolNames: ['Read'],
			cacheReadTokens: 800,
			stream: true
		});
	});

	it('surfaces a mid-stream error in-band', async () => {
		const { stream } = CursorStreamHandler.createStreamResponse(
			options([
				{ kind: 'text', text: 'hi' },
				{ kind: 'end', error: { kind: 'overloaded', message: 'busy' } }
			])
		);
		const chunks = await readSse(stream as ReadableStream<Uint8Array>);
		expect(chunks.some((chunk) => (chunk.error as { code?: string } | undefined)?.code === 'overloaded')).toBe(true);
		expect(record.mock.calls[0][0]).toMatchObject({ stopReason: 'error', error: 'busy' });
	});

	it('records aborted exactly once when the client cancels', async () => {
		let release: () => void = () => undefined;
		async function* hanging(): AsyncGenerator<CursorBridgeEventBody> {
			yield { kind: 'text', text: 'hi' };
			await new Promise<void>((resolve) => (release = resolve));
		}
		const { stream } = CursorStreamHandler.createStreamResponse({ ...options([]), events: hanging() });
		const reader = (stream as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await reader.read();
		await reader.cancel();
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0][0]).toMatchObject({ stopReason: 'aborted', error: null });
	});

	it('collects a non-streaming response', async () => {
		const { response, error } = await CursorStreamHandler.collect(options(COMPOSER_DELTA_ARGS));
		expect(error).toBeNull();
		expect(response?.choices[0]).toMatchObject({
			finish_reason: 'tool_calls',
			message: { content: 'Reading.', tool_calls: [{ id: 'call_c1', function: { arguments: '{"path":"a.ts"}' } }] }
		});
		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0][0]).toMatchObject({ stream: false });
	});

	it('returns the error for a failed non-streaming request with no output', async () => {
		const { response, error } = await CursorStreamHandler.collect(
			options([{ kind: 'end', error: { kind: 'tool_schema', message: 'provider 422', code: 8 } }])
		);
		expect(response).toBeNull();
		expect(error?.kind).toBe('tool_schema');
	});
});

describe('tool argument repair', () => {
	const usage = (outputTokens: number): CursorBridgeEventBody => ({
		kind: 'usage',
		usage: { inputTokens: 100, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null }
	});
	const call = (id: string, args: string, toolIndex: number): CursorBridgeEventBody => ({
		kind: 'toolCall',
		toolCallId: id,
		toolName: 'Read',
		args,
		isComplete: true,
		toolIndex
	});
	const EMPTY_BATCH: CursorBridgeEventBody[] = [
		{ kind: 'text', text: 'Reading both.' },
		call('e1', '{}', 0),
		call('e2', '', 1),
		usage(4),
		{ kind: 'end', error: null }
	];
	const REPAIRED: CursorBridgeEventBody[] = [
		{ kind: 'ready', resolvedModel: 'grok' },
		{ kind: 'text', text: 'Reading both.' },
		call('r1', '{"path":"a"}', 0),
		call('r2', '{"path":"b"}', 1),
		usage(30),
		{ kind: 'end', error: null }
	];

	const repairOptions = (first: CursorBridgeEventBody[], second: CursorBridgeEventBody[]) => {
		const repair = vi.fn((_round: RepairRound) => from(second));

		return { repair, opts: { ...options(first), holdToolCalls: true, repair } };
	};

	const streamedCalls = (chunks: Record<string, unknown>[]) =>
		chunks.flatMap((chunk) =>
			((chunk.choices as { delta?: { tool_calls?: { id?: string; function: { arguments?: string } }[] } }[]) ?? []).flatMap(
				(choice) => choice.delta?.tool_calls ?? []
			)
		);
	const streamedText = (chunks: Record<string, unknown>[]) =>
		chunks
			.flatMap((chunk) =>
				((chunk.choices as { delta?: { content?: string } }[]) ?? []).map((choice) => choice.delta?.content ?? '')
			)
			.join('');

	it('repairs an empty batch once and only sends the repaired calls', async () => {
		const { repair, opts } = repairOptions(EMPTY_BATCH, REPAIRED);
		const chunks = await readSse(CursorStreamHandler.createStreamResponse(opts).stream as ReadableStream<Uint8Array>);

		expect(repair).toHaveBeenCalledTimes(1);
		const round = repair.mock.calls[0][0];
		expect(round.text).toBe('Reading both.');
		expect(round.invalid.map((entry) => entry.id)).toEqual(['e1', 'e2']);

		expect(streamedCalls(chunks).map((entry) => [entry.id, entry.function.arguments])).toEqual([
			['r1', '{"path":"a"}'],
			['r2', '{"path":"b"}']
		]);
		expect(streamedText(chunks)).toBe('Reading both.');
		expect((chunks.at(-1) as { usage: { completion_tokens: number } }).usage.completion_tokens).toBe(34);
		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0][0]).toMatchObject({
			attempts: 2,
			rotationReason: 'tool_args_repair',
			outputTokens: 34,
			toolCallCount: 2,
			stopReason: 'tool_use'
		});
	});

	it('does not repair valid calls', async () => {
		const { repair, opts } = repairOptions(GROK_TOOL_CALL, REPAIRED);
		const chunks = await readSse(CursorStreamHandler.createStreamResponse(opts).stream as ReadableStream<Uint8Array>);

		expect(repair).not.toHaveBeenCalled();
		expect(streamedCalls(chunks).map((entry) => entry.id)).toEqual(['call_g1']);
		expect(record.mock.calls[0][0]).not.toHaveProperty('rotationReason');
	});

	it('gives up after one failed repair and sends the second attempt', async () => {
		const stillEmpty: CursorBridgeEventBody[] = [
			{ kind: 'ready', resolvedModel: 'grok' },
			call('s1', '{}', 0),
			usage(3),
			{ kind: 'end', error: null }
		];
		const { repair, opts } = repairOptions(EMPTY_BATCH, stillEmpty);
		const chunks = await readSse(CursorStreamHandler.createStreamResponse(opts).stream as ReadableStream<Uint8Array>);

		expect(repair).toHaveBeenCalledTimes(1);
		expect(streamedCalls(chunks).map((entry) => [entry.id, entry.function.arguments])).toEqual([['s1', '{}']]);
	});

	it('preserves billing denial during repair without releasing original calls', async () => {
		const failed: CursorBridgeEventBody[] = [
			{ kind: 'end', error: { kind: 'billing_blocked', message: 'Billing cannot be guaranteed' } }
		];
		const { repair, opts } = repairOptions(EMPTY_BATCH, failed);
		const chunks = await readSse(CursorStreamHandler.createStreamResponse(opts).stream as ReadableStream<Uint8Array>);
		expect(repair).toHaveBeenCalledTimes(1);
		expect(streamedCalls(chunks)).toEqual([]);
		expect(chunks).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: 'billing_blocked' }) }));
		const collected = await CursorStreamHandler.collect(repairOptions(EMPTY_BATCH, failed).opts);
		expect(collected.response).toBeNull();
		expect(collected.error?.kind).toBe('billing_blocked');
	});

	it('does not repair an initial billing denial', async () => {
		const { repair, opts } = repairOptions([{ kind: 'end', error: { kind: 'billing_blocked', message: 'Blocked' } }], REPAIRED);
		const result = await CursorStreamHandler.collect(opts);
		expect(result.response).toBeNull();
		expect(result.error?.kind).toBe('billing_blocked');
		expect(repair).not.toHaveBeenCalled();
	});

	it('restores the original calls when the repair invocation errors', async () => {
		const failed: CursorBridgeEventBody[] = [{ kind: 'end', error: { kind: 'rate_limit', message: 'slow down' } }];
		const { opts } = repairOptions(EMPTY_BATCH, failed);
		const chunks = await readSse(CursorStreamHandler.createStreamResponse(opts).stream as ReadableStream<Uint8Array>);

		expect(streamedCalls(chunks).map((entry) => entry.id)).toEqual(['e1', 'e2']);
		expect(chunks.some((chunk) => chunk.error)).toBe(false);
		expect(record.mock.calls[0][0]).toMatchObject({ error: null, rotationReason: 'tool_args_repair' });
	});

	it('repairs in non-streaming collection too', async () => {
		const { repair, opts } = repairOptions(EMPTY_BATCH, REPAIRED);
		const { response } = await CursorStreamHandler.collect(opts);

		expect(repair).toHaveBeenCalledTimes(1);
		expect(response?.choices[0].message).toMatchObject({
			content: 'Reading both.',
			tool_calls: [{ id: 'r1' }, { id: 'r2' }]
		});
	});

	it('builds a repair request with the invalid calls answered by error results', () => {
		const request = buildRepairRequest(
			{ modelId: 'grok', messages: [{ role: 'INFERENCE_MESSAGE_ROLE_USER', text: 'go' }], tools: [] },
			{
				text: 'Reading.',
				calls: [
					{ id: 'e1', name: 'Read', args: '{}' },
					{ id: 'ok', name: 'Grep', args: '{"pattern":"x"}' }
				],
				invalid: [{ id: 'e1', name: 'Read', args: '{}', problems: ['$.path is required'] }]
			}
		);

		expect(request.messages).toHaveLength(3);
		expect(request.messages[1]).toEqual({
			role: 'INFERENCE_MESSAGE_ROLE_ASSISTANT',
			text: 'Reading.',
			toolCalls: [
				{ toolCallId: 'e1', toolName: 'Read', args: {} },
				{ toolCallId: 'ok', toolName: 'Grep', args: { pattern: 'x' } }
			]
		});
		const parts = request.messages[2].toolContent?.parts ?? [];
		expect(parts.every((part) => part.isError)).toBe(true);
		expect(String(parts[0].result)).toContain('$.path is required');
	});
});

describe('Cursor handler conversation context', () => {
	async function capture(sessionKey?: string, model = 'composer-2.5', turn = 0) {
		let captured!: CursorInferenceRequest;
		const client = {
			invoke: (request: CursorInferenceRequest) => {
				captured = request;

				return from([{ kind: 'end', error: { kind: 'billing_blocked', message: 'blocked' } }]);
			}
		} as CursorBridgeClient;
		const reply = {
			raw: { once: vi.fn() },
			request: { headers: { 'x-conversation-id': 'untrusted', 'x-previous-request-id': 'untrusted' } },
			header: vi.fn().mockReturnThis(),
			code: vi.fn().mockReturnThis(),
			send: vi.fn().mockReturnThis()
		} as unknown as FastifyReply;
		await CursorChatHandler.handle(
			{ model, messages: [{ role: 'user', content: 'hello' }, ...(turn ? [{ role: 'assistant' as const, content: 'hi' }] : [])] },
			{
				id: model,
				upstreamModel: model,
				provider: 'cursor',
				label: model,
				sortOrder: 0,
				reasoningBudget: null,
				serviceTier: null,
				toolMode: null
			},
			reply,
			{ sessionKey, turnIndex: turn },
			client
		);

		return captured;
	}

	it('keeps an Ungate UUID stable across turns and model changes, but separates sessions', async () => {
		const first = await capture('session-a');
		const next = await capture('session-a', 'grok-4.7-low-fast', 1);
		const other = await capture('session-b');
		expect(first.conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(next.conversationId).toBe(first.conversationId);
		expect(other.conversationId).not.toBe(first.conversationId);
		for (const request of [first, next, other]) {
			expect(request).not.toHaveProperty('previousRequestId');
			expect(request).not.toHaveProperty('builtInModel');
		}
	});

	it('uses a fresh per-request UUID without session context and ignores client headers', async () => {
		const first = await capture();
		const next = await capture();
		expect(first.conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(next.conversationId).not.toBe(first.conversationId);
		expect(first).not.toHaveProperty('previousRequestId');
		expect(first).not.toHaveProperty('builtInModel');
	});

	it('preserves conversation context through repair without inventing upstream metadata', async () => {
		for (const key of ['session-a', undefined]) {
			const original = await capture(key);
			const repaired = buildRepairRequest(original, { text: '', calls: [], invalid: [] });
			expect(repaired.conversationId).toBe(original.conversationId);
			expect(repaired).not.toHaveProperty('previousRequestId');
			expect(repaired).not.toHaveProperty('builtInModel');
		}
	});
});

describe('Cursor error mapping', () => {
	it.each([false, true])('returns encrypted-session failure before output with stream=%s', async (stream) => {
		const message = 'Encrypted Cursor session cannot be read. Use another provider.';
		const invoke = vi.fn(() => from([{ kind: 'end', error: { kind: 'token_encrypted', message } }]));
		const client = { invoke } as unknown as CursorBridgeClient;
		const header = vi.fn().mockReturnThis();
		const code = vi.fn().mockReturnThis();
		const send = vi.fn().mockReturnThis();
		const reply = {
			raw: { once: vi.fn() },
			request: { headers: {} },
			header,
			code,
			send
		} as unknown as FastifyReply;
		await CursorChatHandler.handle(
			{ model: 'cursor-grok', messages: [{ role: 'user', content: 'hello' }], stream },
			{
				id: 'cursor-grok',
				upstreamModel: 'grok-4.7-low-fast',
				provider: 'cursor',
				label: 'Grok',
				sortOrder: 0,
				reasoningBudget: null,
				serviceTier: null,
				toolMode: null
			},
			reply,
			{},
			client
		);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(code).toHaveBeenCalledExactlyOnceWith(403);
		expect(header).toHaveBeenCalledWith('x-should-retry', 'false');
		expect(send).toHaveBeenCalledExactlyOnceWith({
			error: { message, type: 'permission_error', code: 'cursor_session_encrypted' }
		});
		expect(header).not.toHaveBeenCalledWith('content-type', 'text/event-stream');
	});

	it.each([
		['tool_schema', 502, 'upstream_tool_schema_rejected'],
		['auth', 401, 'cursor_not_signed_in'],
		['rate_limit', 429, 'rate_limit_exceeded'],
		['bad_model', 404, 'model_not_found'],
		['disabled', 403, 'cursor_provider_disabled'],
		['token_encrypted', 403, 'cursor_session_encrypted'],
		['billing_blocked', 403, 'billing_blocked'],
		['unavailable', 503, 'cursor_provider_unavailable']
	] as const)('%s -> %d %s', (kind, status, code) => {
		const mapped = CompletionErrorMapper.cursorError({ kind, message: 'x' });
		expect(mapped.status).toBe(status);
		expect((mapped.body as { error: { code: string } }).error.code).toBe(code);
	});
});

describe('Cursor routing', () => {
	const mapping = (provider: ModelMappingConfig['provider']): ModelMappingConfig => ({
		id: 'cursor-grok',
		label: 'Grok',
		provider,
		upstreamModel: 'grok-4.7-low-fast',
		sortOrder: 0,
		reasoningBudget: null,
		serviceTier: null,
		toolMode: null
	});

	it('routes only explicit cursor mappings, never by model name', () => {
		expect(CompletionModelRouting.isCursorMapped(mapping('cursor'))).toBe(true);
		expect(CompletionModelRouting.isCursorMapped(mapping('claude'))).toBe(false);
		expect(CompletionModelRouting.isCursorMapped(null)).toBe(false);
		expect(CompletionModelRouting.isOpenAiMapped(mapping('cursor'))).toBe(false);
		expect(CompletionModelRouting.shouldRouteMiniMax(mapping('cursor'), 'cursor-grok')).toBe(false);
	});
});
