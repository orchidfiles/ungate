import { describe, expect, it } from 'vitest';

import { ResponsesBodyBuilder } from 'src/proxy/responses-input-normalizer/build-body';
import { ResponsesModelResolver } from 'src/proxy/responses-input-normalizer/resolve-model';

describe('proxy-responses-input-normalizer-modules', () => {
	it('resolves gpt aliases into codex-compatible model and effort', () => {
		expect(ResponsesModelResolver.resolveModel('gpt-5.3')).toEqual({
			model: 'gpt-5.3-codex',
			reasoningEffort: 'medium'
		});
		expect(ResponsesModelResolver.resolveModel('gpt-5.4-high')).toEqual({
			model: 'gpt-5.4',
			reasoningEffort: 'high'
		});
		expect(ResponsesModelResolver.resolveModel('gpt-5.5')).toEqual({
			model: 'gpt-5.5'
		});
		expect(ResponsesModelResolver.resolveModel('gpt-5.5-xhigh')).toEqual({
			model: 'gpt-5.5',
			reasoningEffort: 'xhigh'
		});
	});

	it('maps function tool_choice and keeps passthrough object', () => {
		const { payload: functionChoicePayload } = ResponsesBodyBuilder.buildBody(
			{
				model: 'gpt-5.4',
				messages: [{ role: 'user', content: 'hello' }],
				tools: [{ type: 'function', function: { name: 'Read' } }],
				tool_choice: { type: 'function', function: { name: 'Read' } }
			},
			'gpt-5.4',
			{ instructionsFallback: 'fallback' }
		);

		expect(functionChoicePayload.tool_choice).toEqual({ type: 'function', name: 'Read' });
	});

	it('filters orphan function outputs without matching call ids', () => {
		const { payload } = ResponsesBodyBuilder.buildBody(
			{
				model: 'gpt-5.3-codex',
				messages: [],
				input: [
					{ type: 'function_call_output', call_id: 'orphan', output: 'x' },
					{ type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{}' },
					{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }
				]
			},
			'gpt-5.3-codex',
			{ instructionsFallback: 'fallback' }
		);

		const filtered = payload.input as Array<Record<string, unknown>>;

		expect(filtered).toHaveLength(2);
		expect(filtered[0]).toMatchObject({ type: 'function_call' });
		expect(filtered[1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
	});
});
