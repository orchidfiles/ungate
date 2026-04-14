import { describe, expect, it } from 'vitest';

import { normalizeModelName, openaiToAnthropic } from 'src/adapter/openai-to-anthropic';

describe('openai-to-anthropic', () => {
	it('normalizes legacy model names with reasoning budget', () => {
		expect(normalizeModelName('claude-4.6-opus-high')).toEqual({
			model: 'claude-opus-4-6',
			reasoningBudget: 'high'
		});
		expect(normalizeModelName('claude-4.5-haiku-thinking')).toEqual({
			model: 'claude-haiku-4-5-20251001',
			reasoningBudget: undefined
		});
		expect(normalizeModelName('custom-model')).toEqual({ model: 'custom-model' });
	});

	it('maps system/user/assistant/tool messages and tools', () => {
		const result = openaiToAnthropic({
			model: 'claude-4.6-sonnet-medium',
			messages: [
				{ role: 'system', content: 'first' },
				{ role: 'system', content: 'second' },
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'hello' },
						{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
					]
				},
				{
					role: 'assistant',
					content: 'will call tool',
					tool_calls: [
						{
							id: 'call_1',
							type: 'function',
							function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
						}
					]
				},
				{ role: 'tool', tool_call_id: 'call_1', content: 'tool-result' }
			],
			tools: [
				{
					type: 'function',
					function: {
						name: 'read_file',
						description: 'Read file',
						parameters: { type: 'object', properties: { path: { type: 'string' } } }
					}
				}
			],
			stop: '\nEND',
			stream: true
		});

		expect(result.model).toBe('claude-sonnet-4-6');
		expect(result.reasoning_budget).toBe('medium');
		expect(result.system).toBe('first\nsecond');
		expect(result.stop_sequences).toEqual(['\nEND']);
		expect(result.stream).toBe(true);
		expect(result.tools?.[0]).toEqual({
			name: 'read_file',
			description: 'Read file',
			input_schema: { type: 'object', properties: { path: { type: 'string' } } }
		});
		expect(result.messages[0].role).toBe('user');
		expect(result.messages[1].role).toBe('assistant');
		expect(result.messages[2].role).toBe('user');
	});

	it('keeps anthropic tool blocks and handles invalid tool json', () => {
		const result = openaiToAnthropic({
			model: 'claude-opus-4-6',
			messages: [
				{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { path: 'a' } }] },
				{
					role: 'assistant',
					content: 'broken args',
					tool_calls: [
						{
							id: 'call_bad',
							type: 'function',
							function: { name: 'bad', arguments: '{"broken"' }
						}
					]
				}
			]
		});

		const assistantMessages = result.messages.filter((message) => message.role === 'assistant');
		const allBlocks = assistantMessages.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
		const toolUse = allBlocks.find((block) => (block as Record<string, unknown>).type === 'tool_use' && block.id === 'call_bad');
		expect(toolUse).toBeTruthy();
		expect((toolUse as { input?: Record<string, unknown> }).input).toEqual({ raw: '{"broken"' });
	});

	it('merges tool messages into single user tool_result block and handles stop arrays', () => {
		const result = openaiToAnthropic({
			model: 'claude-opus-4-6',
			stop: ['A', 'B'],
			messages: [
				{
					role: 'assistant',
					content: 'tool call',
					tool_calls: [
						{
							id: 'call_1',
							type: 'function',
							function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
						}
					]
				},
				{ role: 'tool', tool_call_id: 'call_1', content: 'ok1' },
				{ role: 'tool', tool_call_id: 'call_2', content: 'ok2' }
			]
		});

		expect(result.stop_sequences).toEqual(['A', 'B']);
		expect(result.messages[0]).toEqual({ role: 'user', content: 'Continue.' });
		expect(result.messages[1].role).toBe('assistant');
		expect(result.messages[2].role).toBe('user');
		const toolResults = result.messages[2].content as Record<string, unknown>[];
		expect(toolResults).toHaveLength(2);
		expect(toolResults[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: 'ok1' });
		expect(toolResults[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_2', content: 'ok2' });
	});

	it('uses max_completion_tokens when max_tokens is absent', () => {
		const result = openaiToAnthropic({
			model: 'claude-opus-4-6',
			max_completion_tokens: 777,
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(result.max_tokens).toBe(777);
	});
});
