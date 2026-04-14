import { describe, expect, it } from 'vitest';

import { AnthropicToOpenai } from 'src/adapter/anthropic-to-openai';

function parseSseChunk(raw: string): Record<string, unknown> {
	const line = raw
		.trim()
		.split('\n')
		.find((entry) => entry.startsWith('data: '));

	if (!line) {
		throw new Error('SSE chunk has no data line');
	}

	return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
}

describe('anthropic-to-openai', () => {
	it('converts response payload and usage', () => {
		const converted = AnthropicToOpenai.convert(
			{
				id: 'msg_1',
				type: 'message',
				role: 'assistant',
				model: 'claude-sonnet-4-6',
				stop_reason: 'max_tokens',
				stop_sequence: null,
				content: [
					{ type: 'text', text: 'Hello ' },
					{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } },
					{ type: 'text', text: 'world' }
				],
				usage: { input_tokens: 10, output_tokens: 5 }
			},
			'gpt-5.4'
		);

		expect(converted.object).toBe('chat.completion');
		expect(converted.model).toBe('gpt-5.4');
		expect(converted.choices[0].finish_reason).toBe('length');
		expect(converted.choices[0].message.content).toContain('Hello');
		expect(converted.choices[0].message.content).toContain('[Tool: Read]');
		expect(converted.usage).toEqual({
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15
		});
	});

	it('emits stream start and text chunk', () => {
		const start = AnthropicToOpenai.streamStart('id1', 'model1');
		const parsedStart = parseSseChunk(start);
		expect(parsedStart.object).toBe('chat.completion.chunk');
		expect((parsedStart.choices as Record<string, unknown>[])[0].delta).toMatchObject({ role: 'assistant' });

		const chunk = AnthropicToOpenai.streamChunk('id1', 'model1', 'delta');
		const parsedChunk = parseSseChunk(chunk);
		const choice = (parsedChunk.choices as Record<string, unknown>[])[0];
		expect(choice.delta).toMatchObject({ content: 'delta' });
		expect(choice.finish_reason).toBeNull();
	});

	it('emits tool call chunks and usage chunk', () => {
		const first = AnthropicToOpenai.toolCallChunk('id2', 'model2', 0, 'call_1', 'Read', undefined, null);
		const parsedFirst = parseSseChunk(first);
		const firstCall = (
			((parsedFirst.choices as Record<string, unknown>[])[0].delta as Record<string, unknown>).tool_calls as Record<
				string,
				unknown
			>[]
		)[0];
		expect(firstCall.id).toBe('call_1');
		expect((firstCall.function as Record<string, unknown>).name).toBe('Read');

		const args = AnthropicToOpenai.toolCallChunk('id2', 'model2', 0, undefined, undefined, '{"path":"a"}', 'tool_calls');
		const parsedArgs = parseSseChunk(args);
		const argsChoice = (parsedArgs.choices as Record<string, unknown>[])[0];
		expect(argsChoice.finish_reason).toBe('tool_calls');
		expect(((argsChoice.delta as Record<string, unknown>).tool_calls as Record<string, unknown>[])[0].function).toMatchObject({
			arguments: '{"path":"a"}'
		});

		const usage = AnthropicToOpenai.streamChunk('id2', 'model2', undefined, undefined, {
			prompt_tokens: 2,
			completion_tokens: 3,
			total_tokens: 5
		});
		const parsedUsage = parseSseChunk(usage);
		expect(parsedUsage.usage).toEqual({
			prompt_tokens: 2,
			completion_tokens: 3,
			total_tokens: 5
		});
		expect(parsedUsage.choices).toEqual([]);
	});

	it('maps unknown stop reason to stop and fills missing usage with zeroes', () => {
		const converted = AnthropicToOpenai.convert(
			{
				id: 'msg_2',
				type: 'message',
				role: 'assistant',
				model: 'claude-sonnet-4-6',
				stop_reason: 'custom_reason',
				stop_sequence: null,
				content: [],
				usage: undefined
			},
			'gpt-5.4'
		);

		expect(converted.choices[0].finish_reason).toBe('stop');
		expect(converted.choices[0].message.content).toBe('');
		expect(converted.usage).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0
		});
	});
});
