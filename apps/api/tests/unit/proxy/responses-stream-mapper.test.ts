import { describe, expect, it } from 'vitest';

import { createResponsesStreamState, processResponsesChunk } from 'src/proxy/responses-stream-mapper';

function encodeSse(events: Record<string, unknown>[]): string {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function collectChunks(events: Record<string, unknown>[]) {
	const state = createResponsesStreamState('gpt-5.3-codex');
	const out = processResponsesChunk(state, encodeSse(events));
	const chunks = out.filter((x) => x.type === 'chunk').map((x) => x.data!);
	const finish = chunks.at(-1)?.choices as { finish_reason?: string }[] | undefined;
	const toolDeltas = chunks.flatMap(
		(c) => (c.choices as { delta?: { tool_calls?: unknown[] } }[] | undefined)?.[0]?.delta?.tool_calls ?? []
	).length;

	return {
		chunks,
		finishReason: finish?.[0]?.finish_reason ?? null,
		toolDeltas,
		doneCount: out.filter((x) => x.type === 'done').length
	};
}

describe('responses-stream-mapper replay', () => {
	it('handles text-only stream', () => {
		const events = [
			{ type: 'response.created', response: { id: 'resp_text' } },
			{ type: 'response.output_text.delta', delta: 'hello' },
			{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
		];
		const got = collectChunks(events);

		expect(got.finishReason).toBe('stop');
		expect(got.toolDeltas).toBe(0);
		expect(got.doneCount).toBe(1);
	});

	it('handles function_call added + arguments delta + done', () => {
		const events = [
			{ type: 'response.created', response: { id: 'resp_fc' } },
			{
				type: 'response.output_item.added',
				output_index: 0,
				item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'ReadFile', arguments: '' }
			},
			{
				type: 'response.function_call_arguments.delta',
				output_index: 0,
				delta: '{"path":"a.txt"}'
			},
			{
				type: 'response.output_item.done',
				output_index: 0,
				item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'ReadFile', arguments: '{"path":"a.txt"}' }
			},
			{ type: 'response.completed', response: {} }
		];
		const got = collectChunks(events);

		expect(got.finishReason).toBe('tool_calls');
		expect(got.toolDeltas).toBeGreaterThan(0);
	});

	it('handles custom_tool_call with custom_tool_call_input delta', () => {
		const events = [
			{ type: 'response.created', response: { id: 'resp_custom' } },
			{
				type: 'response.output_item.added',
				output_index: 1,
				item: { id: 'ctc_1', type: 'custom_tool_call', call_id: 'call_custom_1', custom: { name: 'EditFile' } }
			},
			{
				type: 'response.custom_tool_call_input.delta',
				output_index: 1,
				delta: '{"path":"a.txt","edit":"x"}'
			},
			{
				type: 'response.output_item.done',
				output_index: 1,
				item: {
					id: 'ctc_1',
					type: 'custom_tool_call',
					call_id: 'call_custom_1',
					custom: { name: 'EditFile' },
					input: { path: 'a.txt', edit: 'x' }
				}
			},
			{ type: 'response.completed', response: {} }
		];
		const got = collectChunks(events);

		expect(got.finishReason).toBe('tool_calls');
		expect(got.toolDeltas).toBeGreaterThan(0);
	});

	it('handles mixed text + custom_tool_call stream', () => {
		const events = [
			{ type: 'response.created', response: { id: 'resp_mix' } },
			{ type: 'response.output_text.delta', delta: 'prep' },
			{
				type: 'response.output_item.added',
				output_index: 2,
				item: { id: 'ctc_2', type: 'custom_tool_call', call_id: 'call_custom_2', custom: { name: 'WriteFile' } }
			},
			{
				type: 'response.custom_tool_call_input.delta',
				output_index: 2,
				delta: '{"path":"b.txt","content":"ok"}'
			},
			{
				type: 'response.output_item.done',
				output_index: 2,
				item: {
					id: 'ctc_2',
					type: 'custom_tool_call',
					call_id: 'call_custom_2',
					custom: { name: 'WriteFile' },
					input: { path: 'b.txt', content: 'ok' }
				}
			},
			{ type: 'response.completed', response: {} }
		];
		const got = collectChunks(events);

		expect(got.finishReason).toBe('tool_calls');
		expect(got.toolDeltas).toBeGreaterThan(0);
	});

	it('emits assistant text from output_text.done when delta never arrived', () => {
		const events = [
			{ type: 'response.created', response: { id: 'resp_done_only' } },
			{ type: 'response.output_text.done', text: 'from-done' },
			{ type: 'response.completed', response: {} }
		];
		const got = collectChunks(events);
		const chunkWithText = got.chunks.find((chunk) => {
			const delta = (chunk.choices as Array<Record<string, unknown>>)[0]?.delta as Record<string, unknown> | undefined;
			return delta?.content === 'from-done';
		});

		expect(chunkWithText).toBeTruthy();
		expect(got.finishReason).toBe('stop');
	});

	it('falls back to response.output assistant text on completion', () => {
		const events = [
			{ type: 'response.created', response: { id: 'resp_fallback' } },
			{
				type: 'response.completed',
				response: {
					output: [
						{
							type: 'message',
							role: 'assistant',
							content: [{ type: 'output_text', text: 'fallback-text' }]
						}
					],
					usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 }
				}
			}
		];
		const got = collectChunks(events);
		const chunkWithText = got.chunks.find((chunk) => {
			const delta = (chunk.choices as Array<Record<string, unknown>>)[0]?.delta as Record<string, unknown> | undefined;
			return delta?.content === 'fallback-text';
		});
		const usageChunk = got.chunks.find((chunk) => chunk.usage) as Record<string, unknown> | undefined;

		expect(chunkWithText).toBeTruthy();
		expect(usageChunk?.usage).toEqual({
			prompt_tokens: 2,
			completion_tokens: 4,
			total_tokens: 6
		});
		expect(got.finishReason).toBe('stop');
	});
});
