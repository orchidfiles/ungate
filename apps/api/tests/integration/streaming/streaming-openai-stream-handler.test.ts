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
