import { describe, expect, it, vi } from 'vitest';

import { SYNTHETIC_THOUGHT_SIGNATURE, buildGeminiRequest, openAiMessagesToGemini } from 'src/adapter/openai-to-gemini';
import { GeminiStreamConverter, GeminiStreamHandler } from 'src/streaming/gemini-stream-handler';

import type { OpenAIChatRequest } from 'src/types/openai';
import type { RequestContext } from 'src/types/proxy';

vi.mock('src/database/requests', () => ({ Requests: { record: vi.fn() } }));

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const event = (parts: unknown[], extra: Record<string, unknown> = {}) =>
	sse({ response: { candidates: [{ content: { role: 'model', parts }, ...extra }] } });

function deltas(chunks: { type: string; data: Record<string, unknown> }[]) {
	return chunks.map((chunk) => (chunk.data.choices as { delta: Record<string, unknown> }[])[0].delta);
}

function body(text: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			}
		})
	);
}

describe('GeminiStreamConverter', () => {
	it('maps thought, text, and functionCall parts to reasoning, content, and tool_calls deltas', () => {
		const converter = new GeminiStreamConverter('gemini-4-carbon');
		const chunks = [
			...converter.push(event([{ thought: true, text: 'Planning.' }])),
			...converter.push(event([{ text: 'Reading ' }, { text: 'the file.' }])),
			...converter.push(
				event(
					[{ functionCall: { id: 'fc-1', name: 'Read', args: { path: 'a.ts' } } }, { functionCall: { name: 'Grep', args: {} } }],
					{
						finishReason: 'STOP'
					}
				)
			)
		];

		expect(deltas(chunks)).toEqual([
			{ role: 'assistant', reasoning_content: 'Planning.' },
			{ content: 'Reading ' },
			{ content: 'the file.' },
			{ tool_calls: [{ index: 0, id: 'fc-1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] },
			{
				tool_calls: [
					{ index: 1, id: expect.stringMatching(/^call_/), type: 'function', function: { name: 'Grep', arguments: '{}' } }
				]
			}
		]);
		expect(converter.text).toBe('Reading the file.');
		expect(converter.reasoningChars).toBe('Planning.'.length);
		expect(converter.finishReason).toBe('tool_calls');
		expect(converter.telemetry()).toMatchObject({ stopReason: 'tool_use', toolCallCount: 2, toolNames: ['Read', 'Grep'] });
	});

	it('reassembles events split across reads and reports the last usage totals', () => {
		const converter = new GeminiStreamConverter('m');
		const raw =
			event([{ text: 'hi' }]) +
			sse({
				response: {
					candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6, cachedContentTokenCount: 3 }
				}
			});
		const half = Math.floor(raw.length / 2) + 3;

		const chunks = [...converter.push(raw.slice(0, half)), ...converter.push(raw.slice(half)), ...converter.flush()];

		expect(deltas(chunks)).toEqual([{ role: 'assistant', content: 'hi' }]);
		expect(converter.finishReason).toBe('length');
		expect(converter.openAiUsage()).toEqual({
			prompt_tokens: 10,
			completion_tokens: 10,
			total_tokens: 20,
			prompt_tokens_details: { cached_tokens: 3 },
			completion_tokens_details: { reasoning_tokens: 6 }
		});
		expect(converter.telemetry()).toMatchObject({ stopReason: 'max_tokens', reasoningTokens: 6, cacheReadTokens: 3 });
	});

	it('turns an in-stream google.rpc error into an OpenAI error event', () => {
		const converter = new GeminiStreamConverter('m');
		const [result] = converter.push(sse({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }));

		expect(result).toMatchObject({
			type: 'error',
			data: { error: { message: 'quota', type: 'rate_limit_error', code: 'resource_exhausted' } },
			upstreamError: { code: 429 }
		});
		expect(converter.telemetry().stopReason).toBe('error');
	});
});

describe('GeminiStreamHandler', () => {
	const context = (): RequestContext => ({ startTime: Date.now(), model: 'gemini-4-carbon', source: 'gemini' }) as RequestContext;

	it('streams OpenAI chunks, a final usage chunk, and [DONE]', async () => {
		const converter = new GeminiStreamConverter('gemini-4-carbon');
		const upstream = body(
			event([{ text: 'ok' }], { finishReason: 'STOP' }) +
				sse({ response: { usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } } })
		);

		const text = await GeminiStreamHandler.createStreamResponse(upstream, converter, context(), vi.fn()).text();
		const payloads = text
			.split('\n\n')
			.filter(Boolean)
			.map((line) => line.replace(/^data: /, ''));

		expect(payloads.at(-1)).toBe('[DONE]');
		const final = JSON.parse(payloads.at(-2)!) as { choices: { finish_reason: string }[]; usage: unknown };
		expect(final.choices[0].finish_reason).toBe('stop');
		expect(final.usage).toMatchObject({ prompt_tokens: 1, completion_tokens: 1 });
	});

	it('forwards a post-commit error without [DONE] and reports it for account cooldown', async () => {
		const converter = new GeminiStreamConverter('m');
		const onStreamError = vi.fn();
		const upstream = body(
			event([{ text: 'partial' }]) + sse({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } })
		);

		const text = await GeminiStreamHandler.createStreamResponse(upstream, converter, context(), onStreamError).text();

		expect(text).not.toContain('[DONE]');
		expect(text).toContain('"rate_limit_error"');
		expect(onStreamError).toHaveBeenCalledWith(expect.objectContaining({ status: 'RESOURCE_EXHAUSTED' }));
	});

	it('flags a stream that ends without a finishReason as incomplete', async () => {
		const text = await GeminiStreamHandler.createStreamResponse(
			body(event([{ text: 'cut' }])),
			new GeminiStreamConverter('m'),
			context(),
			vi.fn()
		).text();

		expect(text).toContain('stream_incomplete');
		expect(text).not.toContain('[DONE]');
	});

	it('drains a buffered response into a chat.completion', async () => {
		const converter = new GeminiStreamConverter('m');
		const ok = await GeminiStreamHandler.drain(
			body(event([{ text: 'all ' }, { text: 'done' }], { finishReason: 'STOP' })),
			converter,
			vi.fn()
		);

		expect(ok).toBe(true);
		expect(converter.completion()).toMatchObject({
			object: 'chat.completion',
			choices: [{ message: { role: 'assistant', content: 'all done' }, finish_reason: 'stop' }]
		});
	});
});

describe('openai-to-gemini', () => {
	it('alternates roles, signs the first replayed functionCall, and names functionResponses after their call', () => {
		const { contents, systemInstruction } = openAiMessagesToGemini([
			{ role: 'system', content: 'Be brief.' },
			{ role: 'user', content: 'Read two files' },
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } },
					{ id: 'c2', type: 'function', function: { name: 'Read', arguments: '{"path":"b"}' } }
				]
			},
			{ role: 'tool', tool_call_id: 'c1', content: 'A' },
			{ role: 'tool', tool_call_id: 'c2', content: '{"text":"B"}' }
		] as never);

		expect(systemInstruction).toEqual({ role: 'user', parts: [{ text: 'Be brief.' }] });
		expect(contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
		expect(contents[1].parts).toEqual([
			{ functionCall: { id: 'c1', name: 'Read', args: { path: 'a' } }, thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE },
			{ functionCall: { id: 'c2', name: 'Read', args: { path: 'b' } } }
		]);
		expect(contents[2].parts).toEqual([
			{ functionResponse: { id: 'c1', name: 'Read', response: { output: 'A' } } },
			{ functionResponse: { id: 'c2', name: 'Read', response: { text: 'B' } } }
		]);
	});

	it('maps tools to parametersJsonSchema and the reasoning tier to thinkingLevel', () => {
		const request = buildGeminiRequest(
			{
				model: 'ungate-gemini-4-carbon-high',
				messages: [{ role: 'user', content: 'hi' }],
				tools: [{ type: 'function', function: { name: 'Shell', description: 'run', parameters: { type: 'object' } } }],
				max_tokens: 100
			} as OpenAIChatRequest,
			{ reasoningBudget: 'high' }
		);

		expect(request.tools).toEqual([
			{ functionDeclarations: [{ name: 'Shell', description: 'run', parametersJsonSchema: { type: 'object' } }] }
		]);
		expect(request.generationConfig).toEqual({
			maxOutputTokens: 100,
			thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' }
		});
		expect(
			buildGeminiRequest({ model: 'x', messages: [] } as never, { reasoningBudget: null }).generationConfig.thinkingConfig
				.thinkingLevel
		).toBe('low');
	});
});
