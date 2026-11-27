import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWithHeadersTimeout, UpstreamHeadersTimeout } from 'src/proxy/upstream-fetch';
import { AnthropicSseTap, type AnthropicStreamSummary } from 'src/streaming/anthropic-sse-tap';

const encoder = new TextEncoder();

/** Sends `parts`, then stays silent forever; records whether it was cancelled. */
function stalling(parts: string[]): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
	let index = 0;
	let wasCancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < parts.length) {
				controller.enqueue(encoder.encode(parts[index++]));

				return undefined;
			}

			return new Promise<void>(() => undefined);
		},
		cancel() {
			wasCancelled = true;
		}
	});

	return { body, cancelled: () => wasCancelled };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('SSE idle watchdog', () => {
	it('cuts a silent Anthropic stream and ends it with event: error', async () => {
		const start = `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } })}\n\n`;
		const upstream = stalling([start]);
		let summary: AnthropicStreamSummary | undefined;

		const out = await new Response(AnthropicSseTap.observe(upstream.body, { onEnd: (s) => (summary = s) }, 20)).text();

		expect(out.startsWith(start)).toBe(true);
		expect(out).toContain('event: error');
		expect(out).toContain('"type":"api_error"');
		expect(upstream.cancelled()).toBe(true);
		expect(summary).toBeDefined();
	});

	it('leaves a stream that keeps sending alone', async () => {
		const parts = ['data: {"type":"ping"}\n\n', 'data: {"type":"message_stop"}\n\n'];
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const next = parts.shift();
				if (!next) return controller.close();
				await new Promise((resolve) => setTimeout(resolve, 5));
				controller.enqueue(encoder.encode(next));
			}
		});

		const out = await new Response(AnthropicSseTap.observe(body, { onEnd: () => undefined }, 50)).text();

		expect(out).not.toContain('event: error');
	});
});

describe('fetchWithHeadersTimeout', () => {
	it('fails with UpstreamHeadersTimeout when no headers arrive in time', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise((_, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
					})
			)
		);

		await expect(fetchWithHeadersTimeout('http://upstream', {}, 10)).rejects.toBeInstanceOf(UpstreamHeadersTimeout);
	});

	it('passes the client cancellation through as itself, not as a timeout', async () => {
		const client = new AbortController();
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise((_, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
					})
			)
		);
		setTimeout(() => client.abort(), 5);

		const error: unknown = await fetchWithHeadersTimeout('http://upstream', {}, 1_000, client.signal).catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(UpstreamHeadersTimeout);
	});
});
