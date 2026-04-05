import { describe, expect, it } from 'vitest';

import { buildChatGptResponsesBody, resolveChatGptModel } from 'src/proxy/responses-input-normalizer';

describe('proxy-responses-input-normalizer', () => {
	it('resolves model aliases and reasoning defaults', () => {
		expect(resolveChatGptModel('')).toEqual({ model: 'gpt-5.4' });
		expect(resolveChatGptModel('gpt-5.3-codex')).toEqual({ model: 'gpt-5.3-codex', reasoningEffort: 'medium' });
		expect(resolveChatGptModel('gpt-5.4-high')).toEqual({ model: 'gpt-5.4', reasoningEffort: 'high' });
		expect(resolveChatGptModel('gpt-5.1-any')).toEqual({ model: 'gpt-5.1-codex-mini', reasoningEffort: 'medium' });
	});

	it('builds payload from chat messages and applies fallback instruction', () => {
		const { payload, debug } = buildChatGptResponsesBody(
			{
				model: 'gpt-5.4',
				messages: [
					{ role: 'system', content: 'sys' },
					{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
					{
						role: 'assistant',
						content: 'ok',
						tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }]
					},
					{ role: 'tool', tool_call_id: 'c1', content: 'done' }
				]
			},
			'gpt-5.4-high',
			{
				instructionsFallback: 'default instructions',
				extraInstruction: '',
				envInstructions: ''
			}
		);

		expect(payload.model).toBe('gpt-5.4');
		expect(payload.stream).toBe(true);
		expect(payload.instructions).toBe('default instructions');
		expect(payload.reasoning).toEqual({ effort: 'high' });
		expect(Array.isArray(payload.input)).toBe(true);
		expect(debug.chatMessages).toBe(4);
	});

	it('uses input field, filters orphan outputs and maps tool_choice', () => {
		const { payload } = buildChatGptResponsesBody(
			{
				model: 'gpt-5.3-codex',
				messages: [],
				input: [
					{ type: 'function_call_output', call_id: 'missing', output: 'x' },
					{ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' },
					{ type: 'function_call_output', call_id: 'c1', output: 'ok' }
				],
				tools: [{ type: 'function', function: { name: 'Read' } }],
				tool_choice: { type: 'function', function: { name: 'Read' } }
			},
			'gpt-5.3-codex',
			{
				instructionsFallback: 'fallback',
				extraInstruction: 'extra',
				envInstructions: 'env'
			}
		);

		const input = payload.input as Record<string, unknown>[];
		expect(input.some((item) => item.type === 'function_call_output' && item.call_id === 'missing')).toBe(false);
		expect(payload.tool_choice).toEqual({ type: 'function', name: 'Read' });
		expect(payload.instructions).toBe('extra');
	});

	it('prefers explicit reasoning over model-derived effort and keeps no tool_choice without tools', () => {
		const { payload } = buildChatGptResponsesBody(
			{
				model: 'gpt-5.4',
				messages: [{ role: 'user', content: 'hello' }],
				reasoning: { effort: 'xhigh' },
				tool_choice: 'required'
			},
			'gpt-5.4-high',
			{
				instructionsFallback: 'fallback',
				extraInstruction: '',
				envInstructions: 'env instructions'
			}
		);

		expect(payload.reasoning).toEqual({ effort: 'xhigh' });
		expect(payload.instructions).toBe('env instructions');
		expect(payload.tool_choice).toBeUndefined();
	});

	it('adds fallback user message when prompt has no actionable user content', () => {
		const { payload } = buildChatGptResponsesBody(
			{
				model: 'gpt-5.4',
				messages: [{ role: 'system', content: 'policy' }]
			},
			'gpt-5.4',
			{
				instructionsFallback: 'fallback',
				extraInstruction: '',
				envInstructions: ''
			}
		);

		const input = payload.input as Record<string, unknown>[];
		const last = input.at(-1)!;
		expect(last.role).toBe('user');
		expect(last.content).toEqual([{ type: 'input_text', text: '.' }]);
	});
});
