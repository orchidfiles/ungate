import { describe, expect, it } from 'vitest';

import {
	buildCodexInputFromOpenAIMessages,
	coerceOpenAIMessagesFromRequestBody,
	expandBodyInputToCodexItems,
	normalizeCodexInputAssistantTextBlocks
} from 'src/proxy/codex-chat-input';

describe('proxy-codex-chat-input', () => {
	it('converts mixed openai messages into codex input preserving order with developer first', () => {
		const input = buildCodexInputFromOpenAIMessages([
			{ role: 'user', content: 'u1' },
			{ role: 'system', content: 'sys' },
			{ role: 'assistant', content: 'a1' },
			{ role: 'tool', tool_call_id: 'call_1', content: 'result' },
			{
				role: 'assistant',
				content: 'a2',
				tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }]
			}
		]);

		expect(input[0]).toMatchObject({ type: 'message', role: 'developer' });
		expect(input.some((item) => item.type === 'function_call')).toBe(true);
		expect(input.some((item) => item.type === 'function_call_output')).toBe(true);
	});

	it('normalizes assistant text blocks into output_text', () => {
		const normalized = normalizeCodexInputAssistantTextBlocks([
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'input_text', text: 'hello' }, { type: 'text', text: 'world' }]
			}
		]);

		const content = normalized[0].content as Array<Record<string, unknown>>;
		expect(content[0].type).toBe('output_text');
		expect(content[1].type).toBe('output_text');
	});

	it('expands mixed body.input items and coerces chat shape', () => {
		const expanded = expandBodyInputToCodexItems([
			{ role: 'system', content: 's' },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u' }] },
			{ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }
		]);

		expect(expanded).toBeTruthy();
		expect(expanded?.[0]).toMatchObject({ type: 'message', role: 'developer' });
		expect(expanded?.at(-1)).toMatchObject({ type: 'function_call' });

		const coerced = coerceOpenAIMessagesFromRequestBody({
			input: [{ role: 'user', content: 'hi' }]
		});
		expect(coerced).toHaveLength(1);
		expect(coerced[0].role).toBe('user');
	});
});
