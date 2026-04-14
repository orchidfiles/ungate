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
});
