import { describe, expect, it } from 'vitest';

import { ResponsesSseProcessor, StreamDiagnostics, StreamStateFactory } from 'src/proxy/responses-stream-mapper';

function encodeSse(events: Record<string, unknown>[]): string {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

describe('StreamDiagnostics.mapUsage', () => {
	it('keeps cached and reasoning token details from Responses usage', () => {
		expect(
			StreamDiagnostics.mapUsage({
				input_tokens: 1000,
				output_tokens: 300,
				total_tokens: 1300,
				input_tokens_details: { cached_tokens: 800 },
				output_tokens_details: { reasoning_tokens: 120 }
			})
		).toEqual({ prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300, cached_tokens: 800, reasoning_tokens: 120 });
	});

	it('accepts chat-completions detail names and omits missing details', () => {
		expect(
			StreamDiagnostics.mapUsage({
				prompt_tokens: 10,
				completion_tokens: 5,
				prompt_tokens_details: { cached_tokens: 4 }
			})
		).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 0, cached_tokens: 4 });
		expect(StreamDiagnostics.mapUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 3 })).toEqual({
			prompt_tokens: 1,
			completion_tokens: 2,
			total_tokens: 3
		});
		expect(StreamDiagnostics.mapUsage(undefined)).toBeUndefined();
	});
});

describe('StreamDiagnostics.telemetry', () => {
	it('reports tool calls, cache and reasoning for a completed tool stream', () => {
		const state = StreamStateFactory.create('gpt-6');
		ResponsesSseProcessor.process(
			state,
			encodeSse([
				{ type: 'response.created', response: { id: 'r1' } },
				{
					type: 'response.output_item.added',
					output_index: 0,
					item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'Shell', arguments: '' }
				},
				{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"command":"ls"}' },
				{
					type: 'response.output_item.done',
					output_index: 0,
					item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'Shell', arguments: '{"command":"ls"}' }
				},
				{
					type: 'response.completed',
					response: {
						status: 'completed',
						usage: {
							input_tokens: 500,
							output_tokens: 50,
							total_tokens: 550,
							input_tokens_details: { cached_tokens: 400 },
							output_tokens_details: { reasoning_tokens: 20 }
						}
					}
				}
			])
		);

		expect(StreamDiagnostics.telemetry(state)).toEqual({
			stopReason: 'tool_use',
			toolCallCount: 1,
			toolNames: ['Shell'],
			cacheReadTokens: 400,
			cacheCreationTokens: 0,
			reasoningTokens: 20
		});
		expect(state.firstTokenAt).toBeTypeOf('number');
	});

	it('maps incomplete to max_tokens and missing terminal or override to error/aborted', () => {
		const incomplete = StreamStateFactory.create('gpt-6');
		ResponsesSseProcessor.process(
			incomplete,
			encodeSse([
				{ type: 'response.output_text.delta', delta: 'partial' },
				{
					type: 'response.incomplete',
					response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
				}
			])
		);

		expect(StreamDiagnostics.telemetry(incomplete).stopReason).toBe('max_tokens');
		expect(StreamDiagnostics.telemetry(StreamStateFactory.create('gpt-6')).stopReason).toBe('error');
		expect(StreamDiagnostics.telemetry(incomplete, 'aborted').stopReason).toBe('aborted');
		expect(StreamDiagnostics.telemetry(StreamStateFactory.create('gpt-6')).cacheReadTokens).toBeNull();
	});
});
