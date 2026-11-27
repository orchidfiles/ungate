import { describe, expect, it, vi } from 'vitest';

import { AnthropicSseTap, type AnthropicStreamSummary } from 'src/streaming/anthropic-sse-tap';

function chunks(parts: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(encoder.encode(part));
			controller.close();
		}
	});
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

describe('AnthropicSseTap', () => {
	it('forwards bytes unchanged across split events and summarises the stream', async () => {
		const start = `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`;
		const thinking = `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'abcd' } })}\n\n`;
		const stop = `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })}\n\ndata: {"type":"message_stop"}\n\n`;
		const raw = start + thinking + stop;
		const parts = [raw.slice(0, 17), raw.slice(17, 80), raw.slice(80)];
		let summary: AnthropicStreamSummary | undefined;

		const out = await drain(AnthropicSseTap.observe(chunks(parts), { onEnd: (s) => (summary = s) }));

		expect(out).toBe(raw);
		expect(summary).toMatchObject({ inputTokens: 3, outputTokens: 9, reasoningChars: 4, stopReason: 'end_turn', error: null });
	});

	it('reports an upstream error event once and ends as an error', async () => {
		const onError = vi.fn();
		const error = `data: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })}\n\n`;
		let summary: AnthropicStreamSummary | undefined;

		await drain(AnthropicSseTap.observe(chunks([error, error]), { onError, onEnd: (s) => (summary = s) }));

		expect(onError).toHaveBeenCalledTimes(1);
		expect(summary).toMatchObject({ stopReason: 'error', error: 'busy' });
	});

	it('marks a stream that ends without message_stop as an error', async () => {
		let summary: AnthropicStreamSummary | undefined;
		await drain(AnthropicSseTap.observe(chunks(['data: {"type":"ping"}\n\n']), { onEnd: (s) => (summary = s) }));

		expect(summary).toMatchObject({ stopReason: 'error', error: 'Upstream stream ended before message_stop' });
	});

	it('records a downstream cancel as aborted and cancels upstream', async () => {
		const cancel = vi.fn();
		const upstream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel });
		const onEnd = vi.fn();

		await AnthropicSseTap.observe(upstream, { onEnd }).cancel('gone');

		expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'aborted' }));
		expect(cancel).toHaveBeenCalledWith('gone');
	});
});
