import { beforeEach, describe, expect, it, vi } from 'vitest';

const record = vi.fn();
vi.mock('src/database/requests', () => ({ Requests: { record: (...args: unknown[]) => record(...args) } }));

const { CursorResponseAccumulator, CursorStreamHandler } = await import('src/streaming/cursor-stream-handler');
const { CompletionErrorMapper, CompletionModelRouting } = await import('src/orchestration/openai');
const { CursorBridgeClient } = await import('src/proxy/cursor-bridge-client');

import type { CursorBridgeEventBody, ModelMappingConfig, RequestTelemetry } from '@ungate/shared';
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
	for (const event of events) yield event;
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
			{ tool_calls: [{ index: 0, id: 'call_g1', type: 'function', function: { name: 'Read', arguments: '{"path":"README.md"}' } }] }
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
		expect(acc.toolCalls).toEqual([{ id: 'call_c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }]);
	});

	it('maps the output token limit to length', () => {
		const acc = new CursorResponseAccumulator('grok', tools);
		acc.apply({ kind: 'text', text: 'partial' });
		acc.apply({ kind: 'end', error: { kind: 'upstream', message: 'limit', code: 'INFERENCE_STREAM_ERROR_TYPE_OUTPUT_TOKEN_LIMIT' } });
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

describe('Cursor error mapping', () => {
	it.each([
		['tool_schema', 502, 'upstream_tool_schema_rejected'],
		['auth', 401, 'cursor_not_signed_in'],
		['rate_limit', 429, 'rate_limit_exceeded'],
		['bad_model', 404, 'model_not_found'],
		['disabled', 403, 'cursor_provider_disabled'],
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

describe('CursorBridgeClient', () => {
	it('reports unavailable without an IPC channel', async () => {
		const client = new CursorBridgeClient({ on: () => undefined, off: () => undefined });
		expect(await client.status()).toMatchObject({ available: false, reason: 'no_bridge' });
		const events: CursorBridgeEventBody[] = [];
		for await (const event of client.invoke({ modelId: 'grok', messages: [], tools: [] })) events.push(event);
		expect(events).toEqual([{ kind: 'end', error: expect.objectContaining({ kind: 'unavailable' }) }]);
	});

	it('correlates events by id and sends cancel on abort', async () => {
		const sent: Record<string, unknown>[] = [];
		let listener: (message: unknown) => void = () => undefined;
		const client = new CursorBridgeClient({
			send: (message) => {
				sent.push(message as Record<string, unknown>);
				const { id, kind } = message as { id: string; kind: string };
				if (kind === 'invoke') {
					queueMicrotask(() => {
						listener({ channel: 'ungate.cursor-bridge', id: 'other', kind: 'text', text: 'not mine' });
						listener({ channel: 'ungate.cursor-bridge', id, kind: 'ready', resolvedModel: 'grok' });
						listener({ channel: 'ungate.cursor-bridge', id, kind: 'text', text: 'hello' });
					});
				}

				return true;
			},
			on: (_event, fn) => (listener = fn),
			off: () => undefined
		});
		const controller = new AbortController();
		const events: CursorBridgeEventBody[] = [];
		for await (const event of client.invoke({ modelId: 'grok', messages: [], tools: [] }, controller.signal)) {
			events.push(event);
			if (event.kind === 'text') controller.abort();
		}
		expect(events.map((event) => event.kind)).toEqual(['ready', 'text', 'end']);
		expect(sent.map((message) => message.kind)).toEqual(['invoke', 'cancel']);
		expect(JSON.stringify(sent)).not.toMatch(/token|authorization|checksum/i);
	});
});
