import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';

const recordMock = vi.fn();

vi.mock('src/database/requests', () => ({
	Requests: {
		record: (...args: unknown[]) => recordMock(...args)
	}
}));

function createResponseWithSse(lines: string[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode(lines.join('\n') + '\n'));
			controller.close();
		}
	});

	return new Response(stream);
}

async function readStream(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		out += decoder.decode(value, { stream: true });
	}

	out += decoder.decode();

	return out;
}

interface StreamToolCallChunk {
	index: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

function readToolCalls(output: string): StreamToolCallChunk[] {
	const toolCalls: StreamToolCallChunk[] = [];

	for (const line of output.split('\n')) {
		if (!line.startsWith('data: {')) {
			continue;
		}

		const chunk = JSON.parse(line.slice(6)) as {
			choices?: { delta?: { tool_calls?: StreamToolCallChunk[] } }[];
		};
		for (const choice of chunk.choices ?? []) {
			if (choice.delta?.tool_calls) {
				toolCalls.push(...choice.delta.tool_calls);
			}
		}
	}

	return toolCalls;
}

describe('streaming-openai-stream-handler', () => {
	afterEach(() => {
		recordMock.mockReset();
	});

	it('creates stream headers and processes text events with usage', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0,"cache_read_input_tokens":1,"cache_creation_input_tokens":2}}}',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
			'data: {"type":"message_delta","usage":{"output_tokens":7}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream, headers } = OpenAIStreamHandler.createStreamResponse(response, 'st1', 'model1', {
			model: 'model1',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		expect(headers['Content-Type']).toBe('text/event-stream');
		expect(headers['x-request-id']).toBe('req_st1');

		const output = await readStream(stream);
		expect(output).toContain('"role":"assistant"');
		expect(output).toContain('"content":"hello"');
		expect(output).toContain('"finish_reason":"stop"');
		expect(output).toContain('"usage"');
		expect(output).toContain('data: [DONE]');
		expect(recordMock).toHaveBeenCalledTimes(1);
	});

	it('handles tool_use flow and malformed chunks', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tu1","name":"Read"}}',
			'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
			'data: {"type":"content_block_stop"}',
			'data: not-json',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st2', 'model2', {
			model: 'model2',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: { Read: 'read_file' }
		});

		const output = await readStream(stream);
		expect(output).toContain('"tool_calls"');
		expect(output).toContain('"name":"read_file"');
		expect(output).toContain('"finish_reason":"tool_calls"');
		expect(output).toContain('data: [DONE]');
	});

	it('keeps parallel tool calls and their arguments isolated when JSON fragments interleave', async () => {
		const event = (value: unknown) => `data: ${JSON.stringify(value)}`;
		const response = createResponseWithSse([
			event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
			event({ type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'tu1', name: 'Read' } }),
			event({ type: 'content_block_start', index: 9, content_block: { type: 'tool_use', id: 'tu2', name: 'Write' } }),
			event({ type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
			event({ type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
			event({ type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }),
			event({ type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '"b.ts"}' } }),
			event({ type: 'content_block_stop', index: 4 }),
			event({ type: 'content_block_stop', index: 9 }),
			event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
			event({ type: 'message_stop' })
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st_parallel', 'model_parallel', {
			model: 'model_parallel',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		const toolCalls = readToolCalls(output);

		expect(toolCalls).toEqual([
			{ index: 0, id: 'tu1', type: 'function', function: { name: 'Read', arguments: '' } },
			{ index: 1, id: 'tu2', type: 'function', function: { name: 'Write', arguments: '' } },
			{ index: 0, function: { arguments: '{"path":"a.ts"}' } },
			{ index: 1, function: { arguments: '{"path":"b.ts"}' } }
		]);
		expect(output).toContain('"finish_reason":"tool_calls"');
	});

	it('salvages every open parallel tool call when message_stop omits block stops', async () => {
		const event = (value: unknown) => `data: ${JSON.stringify(value)}`;
		const response = createResponseWithSse([
			event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
			event({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu3', name: 'Read' } }),
			event({ type: 'content_block_start', index: 8, content_block: { type: 'tool_use', id: 'tu4', name: 'Write' } }),
			event({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } }),
			event({ type: 'content_block_delta', index: 8, delta: { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' } }),
			event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
			event({ type: 'message_stop' })
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st_parallel_salvage', 'model_parallel', {
			model: 'model_parallel',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		const toolCalls = readToolCalls(output);

		expect(toolCalls).toEqual([
			{ index: 0, id: 'tu3', type: 'function', function: { name: 'Read', arguments: '' } },
			{ index: 1, id: 'tu4', type: 'function', function: { name: 'Write', arguments: '' } },
			{ index: 0, function: { arguments: '{"path":"a.ts"}' } },
			{ index: 1, function: { arguments: '{"path":"b.ts"}' } }
		]);
		expect(output).toContain('"finish_reason":"tool_calls"');
	});

	it('throws when upstream response has no body', () => {
		expect(() =>
			OpenAIStreamHandler.createStreamResponse(new Response(null), 'st3', 'model3', {
				model: 'model3',
				source: 'claude',
				startTime: Date.now(),
				reverseToolMapping: {}
			})
		).toThrowError('No response body');
	});

	it('emits arguments, tool_calls, usage, and DONE once for a completed tool stream', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"Read"}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
			'data: {"type":"content_block_stop","index":0}',
			'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st4', 'model4', {
			model: 'model4',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: { Read: 'read_file' }
		});

		const output = await readStream(stream);
		expect(output).toContain('"name":"read_file"');
		expect(output).toContain('\\"path\\":\\"a.ts\\"');
		expect(output).toContain('"finish_reason":"tool_calls"');
		expect(output.match(/"finish_reason":"tool_calls"/g)).toHaveLength(1);
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
		expect(recordMock).toHaveBeenCalledTimes(1);
	});

	it('salvages complete arguments on tool_use message_stop without a block stop', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu2","name":"CreatePlan"}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\"Plan\\"}"}}',
			'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st5', 'model5', {
			model: 'model5',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		expect(output).toContain('"name":"CreatePlan"');
		expect(output).toContain('\\"name\\":\\"Plan\\"');
		expect(output).toContain('"finish_reason":"tool_calls"');
	});

	it('finishes as length when a tool_use salvage cannot parse the arguments', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu10","name":"Write"}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\""}}',
			'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st10', 'model10', {
			model: 'model10',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		errorSpy.mockRestore();

		expect(output).toContain('"name":"Write"');
		expect(output).not.toContain('\\"path\\":\\"a.ts\\"');
		expect(output).toContain('"finish_reason":"length"');
		expect(output).not.toContain('"finish_reason":"stop"');
		expect(output).not.toContain('"finish_reason":"tool_calls"');
	});

	it.each(['end_turn', 'refusal', 'pause_turn', 'stop_sequence'])(
		'finishes as length for an open tool on %s, even after a completed call',
		async (stopReason) => {
			const event = (data: object) => `data: ${JSON.stringify(data)}`;
			const response = createResponseWithSse([
				event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
				event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'done', name: 'Read' } }),
				event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"done"}' } }),
				event({ type: 'content_block_stop', index: 0 }),
				event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'open', name: 'Write' } }),
				event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"unfinished"' } }),
				event({ type: 'message_delta', delta: { stop_reason: stopReason } }),
				event({ type: 'message_stop' })
			]);
			const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'incomplete', 'model', {
				model: 'model', source: 'claude', startTime: Date.now(), reverseToolMapping: {}
			});
			const output = await readStream(stream);
			expect(output).toContain('\\"path\\":\\"done\\"');
			expect(output).not.toContain('unfinished');
			expect(output).toContain('"finish_reason":"length"');
			expect(output).not.toContain('"finish_reason":"tool_calls"');
		}
	);

	it.each(['message_stop', 'done'])('finishes as length for a single open tool on %s', async (ending) => {
		const event = (data: object) => `data: ${JSON.stringify(data)}`;
		const response = createResponseWithSse([
			event({ type: 'message_start' }),
			event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'open', name: 'Write' } }),
			event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"unfinished"' } }),
			event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
			ending === 'done' ? 'data: [DONE]' : event({ type: 'message_stop' })
		]);
		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'incomplete', 'model', {
			model: 'model', source: 'claude', startTime: Date.now(), reverseToolMapping: {}
		});
		const output = await readStream(stream);
		expect(output).not.toContain('unfinished');
		expect(output).toContain('"finish_reason":"length"');
		expect(output).not.toContain('"finish_reason":"stop"');
	});

	it('does not emit truncated JSON and finishes as length on max_tokens', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu3","name":"Write"}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\""}}',
			'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st6', 'model6', {
			model: 'model6',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		expect(output).toContain('"name":"Write"');
		expect(output).not.toContain('"path":"a.ts"');
		expect(output).toContain('"finish_reason":"length"');
		expect(output).not.toContain('"finish_reason":"tool_calls"');
	});

	it('does not execute a dangling tool on unexpected EOF even if JSON parses', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu4","name":"Shell"}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"rm -rf /\\"}"}}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st7', 'model7', {
			model: 'model7',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		errorSpy.mockRestore();

		expect(output).toContain('"name":"Shell"');
		expect(output).not.toContain('rm -rf /');
		expect(output).toContain('"finish_reason":"length"');
		expect(output).not.toContain('"finish_reason":"tool_calls"');
		expect(output).toContain('data: [DONE]');
	});

	it('ignores content_block_stop for a different index while a tool is open', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu5","name":"Read"}}',
			'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
			'data: {"type":"content_block_stop","index":0}',
			'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st8', 'model8', {
			model: 'model8',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		expect(output).toContain('"name":"Read"');
		expect(output).not.toContain('"path":"a.ts"');
		expect(output).toContain('"finish_reason":"length"');
	});

	it('emits keepalive chunks while the upstream is silent, then finishes normally', async () => {
		const encoder = new TextEncoder();
		const event = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n`);
		const response = new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }));
					controller.enqueue(event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
					await new Promise((resolve) => setTimeout(resolve, 120));
					controller.enqueue(event({ type: 'content_block_stop', index: 0 }));
					controller.enqueue(event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
					controller.enqueue(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } }));
					controller.enqueue(event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }));
					controller.enqueue(event({ type: 'message_stop' }));
					controller.close();
				}
			})
		);

		const { stream } = OpenAIStreamHandler.createStreamResponse(
			response,
			'st_keepalive',
			'model_keepalive',
			{ model: 'model_keepalive', source: 'claude', startTime: Date.now(), reverseToolMapping: {} },
			{ keepaliveIntervalMs: 20 }
		);

		const output = await readStream(stream);
		const keepalives = output.split('\n').filter((line) => line.includes('"delta":{"content":""}'));

		expect(keepalives.length).toBeGreaterThanOrEqual(2);
		expect(output.indexOf('"role":"assistant"')).toBeLessThan(output.indexOf('"delta":{"content":""}'));
		expect(output).toContain('"content":"done"');
		expect(output).toContain('"finish_reason":"stop"');
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
		expect(output.trimEnd().endsWith('data: [DONE]')).toBe(true);
	});

	it('keeps the stream alive while tool arguments are buffered and still emits them intact', async () => {
		const encoder = new TextEncoder();
		const event = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n`);
		const response = new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }));
					controller.enqueue(event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_slow', name: 'Write' } }));
					controller.enqueue(event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"big.md",' } }));
					await new Promise((resolve) => setTimeout(resolve, 120));
					controller.enqueue(event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"contents":"x"}' } }));
					controller.enqueue(event({ type: 'content_block_stop', index: 0 }));
					controller.enqueue(event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }));
					controller.enqueue(event({ type: 'message_stop' }));
					controller.close();
				}
			})
		);

		const { stream } = OpenAIStreamHandler.createStreamResponse(
			response,
			'st_tool_keepalive',
			'model_tool_keepalive',
			{ model: 'model_tool_keepalive', source: 'claude', startTime: Date.now(), reverseToolMapping: {} },
			{ keepaliveIntervalMs: 20 }
		);

		const output = await readStream(stream);
		const headerAt = output.indexOf('"id":"tu_slow"');
		const keepaliveAt = output.indexOf('"delta":{"content":""}');
		const argsAt = output.indexOf('\\"contents\\":\\"x\\"');

		expect(headerAt).toBeGreaterThan(-1);
		expect(keepaliveAt).toBeGreaterThan(headerAt);
		expect(argsAt).toBeGreaterThan(keepaliveAt);
		expect(readToolCalls(output)).toEqual([
			{ index: 0, id: 'tu_slow', type: 'function', function: { name: 'Write', arguments: '' } },
			{ index: 0, function: { arguments: '{"path":"big.md","contents":"x"}' } }
		]);
		expect(output).toContain('"finish_reason":"tool_calls"');
		expect(output.trimEnd().endsWith('data: [DONE]')).toBe(true);
	});

	it('does not emit keepalives when the upstream finishes before the interval', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fast"}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st_fast', 'model_fast', {
			model: 'model_fast',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);

		expect(output).not.toContain('"delta":{"content":""}');
		expect(output).toContain('"content":"fast"');
	});

	it('stops keepalives once the client cancels', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
		const encoder = new TextEncoder();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n'));
				}
			})
		);

		const { stream } = OpenAIStreamHandler.createStreamResponse(
			response,
			'st_cancel_keepalive',
			'model_cancel',
			{ model: 'model_cancel', source: 'claude', startTime: Date.now(), reverseToolMapping: {} },
			{ keepaliveIntervalMs: 10 }
		);

		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let out = '';

		while (!out.includes('"delta":{"content":""}')) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			out += decoder.decode(value, { stream: true });
		}

		await reader.cancel('client abort');
		await new Promise((resolve) => setTimeout(resolve, 50));

		const intervalCount = setIntervalSpy.mock.calls.length;
		const keepaliveTimer = setIntervalSpy.mock.results[0]?.value;
		const clearedTimers = clearIntervalSpy.mock.calls.map((call) => call[0]);

		errorSpy.mockRestore();
		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();

		expect(out).toContain('"delta":{"content":""}');
		expect(intervalCount).toBe(1);
		expect(keepaliveTimer).toBeDefined();
		expect(clearedTimers).toContain(keepaliveTimer);
	});

	it('aborts a silent upstream after the idle timeout and ends the stream as incomplete', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const encoder = new TextEncoder();
		let upstreamCancelReason: unknown = null;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n'));
					controller.enqueue(
						encoder.encode(
							'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_dead","name":"Shell"}}\n'
						)
					);
					controller.enqueue(
						encoder.encode(
							'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n'
						)
					);
				},
				cancel(reason) {
					upstreamCancelReason = reason;
				}
			})
		);

		const started = Date.now();
		const { stream } = OpenAIStreamHandler.createStreamResponse(
			response,
			'st_idle',
			'model_idle',
			{ model: 'model_idle', source: 'claude', startTime: Date.now(), reverseToolMapping: {} },
			{ keepaliveIntervalMs: 10, upstreamIdleTimeoutMs: 60 }
		);

		const output = await readStream(stream);
		const elapsed = Date.now() - started;
		const errors = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
		errorSpy.mockRestore();

		expect(elapsed).toBeLessThan(2000);
		expect(String(upstreamCancelReason)).toContain('upstream idle');
		expect(errors).toContain('Aborting upstream stream id=st_idle');
		expect(output).toContain('"name":"Shell"');
		expect(output).not.toContain('\\"command\\":\\"ls\\"');
		expect(output).toContain('"finish_reason":"length"');
		expect(output).not.toContain('"finish_reason":"tool_calls"');
		expect(output.trimEnd().endsWith('data: [DONE]')).toBe(true);
	});

	it('never cuts off a long stream while the upstream keeps sending pings', async () => {
		const encoder = new TextEncoder();
		const event = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n`);
		let upstreamCancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }));
					controller.enqueue(event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));

					// Run for 10x the idle timeout, only ever sending pings and thinking.
					for (let i = 0; i < 25; i++) {
						await new Promise((resolve) => setTimeout(resolve, 20));
						controller.enqueue(
							i % 2 === 0
								? encoder.encode('event: ping\ndata: {"type":"ping"}\n')
								: event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'still working' } })
						);
					}

					controller.enqueue(event({ type: 'content_block_stop', index: 0 }));
					controller.enqueue(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'finished' } }));
					controller.enqueue(event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }));
					controller.enqueue(event({ type: 'message_stop' }));
					controller.close();
				},
				cancel() {
					upstreamCancelled = true;
				}
			})
		);

		const started = Date.now();
		const { stream } = OpenAIStreamHandler.createStreamResponse(
			response,
			'st_long_alive',
			'model_long',
			{ model: 'model_long', source: 'claude', startTime: Date.now(), reverseToolMapping: {} },
			{ keepaliveIntervalMs: 10, upstreamIdleTimeoutMs: 50 }
		);

		const output = await readStream(stream);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(450);
		expect(upstreamCancelled).toBe(false);
		expect(output).not.toContain('"content":"still working"');
		expect(output).toContain('"content":"finished"');
		expect(output).toContain('"finish_reason":"stop"');
		expect(output).not.toContain('"finish_reason":"length"');
	});

	it('does not abort a slow upstream that is still sending events', async () => {
		const encoder = new TextEncoder();
		const event = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n`);
		const response = new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }));

					for (let i = 0; i < 6; i++) {
						await new Promise((resolve) => setTimeout(resolve, 30));
						controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n'));
					}

					controller.enqueue(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow but alive' } }));
					controller.enqueue(event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }));
					controller.enqueue(event({ type: 'message_stop' }));
					controller.close();
				}
			})
		);

		const { stream } = OpenAIStreamHandler.createStreamResponse(
			response,
			'st_slow_alive',
			'model_slow',
			{ model: 'model_slow', source: 'claude', startTime: Date.now(), reverseToolMapping: {} },
			{ keepaliveIntervalMs: 10, upstreamIdleTimeoutMs: 80 }
		);

		const output = await readStream(stream);

		expect(output).toContain('"content":"slow but alive"');
		expect(output).toContain('"finish_reason":"stop"');
		expect(output).not.toContain('"finish_reason":"length"');
	});

	it('forwards summarized thinking as reasoning_content, separate from the reply text', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Checking the retry path."}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" It never refreshes the token."}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIYAhIM"}}',
			'data: {"type":"content_block_stop","index":0}',
			'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
			'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Found it."}}',
			'data: {"type":"content_block_stop","index":1}',
			'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st_thinking', 'model_thinking', {
			model: 'model_thinking',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		const reasoning = output
			.split('\n')
			.filter((line) => line.startsWith('data: {'))
			.map((line) => JSON.parse(line.slice(6)) as { choices?: { delta?: { reasoning_content?: string } }[] })
			.map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content ?? '')
			.join('');

		expect(reasoning).toBe('Checking the retry path. It never refreshes the token.');
		expect(output.indexOf('"reasoning_content"')).toBeLessThan(output.indexOf('"content":"Found it."'));
		expect(output).not.toContain('"content":"Checking the retry path."');
		expect(output).not.toContain('EqQBCgIYAhIM');
		expect(output).toContain('"finish_reason":"stop"');
	});

	it('emits nothing for omitted thinking, which streams an empty thinking_delta', async () => {
		const response = createResponseWithSse([
			'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EosnCkYI"}}',
			'data: {"type":"content_block_stop","index":0}',
			'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}',
			'data: {"type":"message_stop"}'
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st_omitted', 'model_omitted', {
			model: 'model_omitted',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);

		expect(output).not.toContain('reasoning_content');
		expect(output).not.toContain('EosnCkYI');
		expect(output).toContain('"content":"done"');
	});

	it('keeps tool calls intact when thinking precedes them', async () => {
		const event = (value: unknown) => `data: ${JSON.stringify(value)}`;
		const response = createResponseWithSse([
			event({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
			event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
			event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Read the file first.' } }),
			event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
			event({ type: 'content_block_stop', index: 0 }),
			event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_think', name: 'Read' } }),
			event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } }),
			event({ type: 'content_block_stop', index: 1 }),
			event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
			event({ type: 'message_stop' })
		]);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st_think_tool', 'model_think_tool', {
			model: 'model_think_tool',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);

		expect(output).toContain('"reasoning_content":"Read the file first."');
		expect(readToolCalls(output)).toEqual([
			{ index: 0, id: 'tu_think', type: 'function', function: { name: 'Read', arguments: '' } },
			{ index: 0, function: { arguments: '{"path":"a.ts"}' } }
		]);
		expect(output).toContain('"finish_reason":"tool_calls"');
	});

	it('logs downstream cancellation without flushing an open tool', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const encoder = new TextEncoder();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu6","name":"Write"}}\n'
						)
					);
				}
			})
		);

		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'st9', 'model9', {
			model: 'model9',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let out = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			out += decoder.decode(value, { stream: true });
			if (out.includes('"name":"Write"')) {
				await reader.cancel('client abort');
				break;
			}
		}

		const errors = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
		errorSpy.mockRestore();

		expect(out).toContain('"name":"Write"');
		expect(out).not.toContain('"finish_reason":"tool_calls"');
		expect(out).not.toContain('"finish_reason":"length"');
		expect(out).not.toContain('"finish_reason":"stop"');
		expect(errors).toContain('Downstream cancelled');
		expect(errors).toContain('Write');
		expect(errors).toContain('tu6');
		expect(recordMock).not.toHaveBeenCalled();
	});
});
