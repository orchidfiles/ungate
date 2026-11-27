import { RequestHeuristics } from '../metrics/request-heuristics';

import type { AnthropicStreamEvent } from '../types/anthropic-stream';
import type { StopReason } from '@ungate/shared';

/** What a forwarded Anthropic stream reported, read without changing a byte of it. */
export interface AnthropicStreamSummary {
	/** Total prompt size, including cache reads and writes (the split is kept below). */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
	reasoningChars: number | null;
	toolNames: string[];
	firstTokenAt: number | null;
	stopReason: StopReason;
	/** Message of an upstream `error` event, or why the stream ended early. */
	error: string | null;
}

export interface AnthropicSseTapHooks {
	/** Upstream `error` event after HTTP 200 (post-commit, never retried); called at most once. */
	onError?: (error: Record<string, unknown> | undefined) => void;
	/** Called exactly once, when the stream completes, fails or the downstream client cancels. */
	onEnd: (summary: AnthropicStreamSummary) => void;
}

const MAX_CARRY = 256 * 1024;

/**
 * Byte-for-byte passthrough of an Anthropic SSE body that reads usage, stop reason, tool names and
 * `error` events as they pass. Downstream cancellation cancels the upstream body.
 */
export class AnthropicSseTap {
	static observe(body: ReadableStream<Uint8Array>, hooks: AnthropicSseTapHooks): ReadableStream<Uint8Array> {
		const decoder = new TextDecoder();
		const reader = body.getReader();
		let buffer = '';
		let ended = false;
		let errorReported = false;
		let sawMessageStop = false;
		let rawStopReason: string | null = null;
		let streamError: string | null = null;
		const summary: AnthropicStreamSummary = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: null,
			cacheCreationTokens: null,
			reasoningChars: null,
			toolNames: [],
			firstTokenAt: null,
			stopReason: 'unknown',
			error: null
		};

		const handle = (event: AnthropicStreamEvent) => {
			switch (event.type) {
				case 'message_start': {
					const usage = event.message?.usage;
					if (!usage) return;
					const cacheRead = usage.cache_read_input_tokens ?? 0;
					const cacheCreation = usage.cache_creation_input_tokens ?? 0;
					summary.inputTokens = (usage.input_tokens ?? 0) + cacheRead + cacheCreation;
					summary.outputTokens = usage.output_tokens ?? 0;
					summary.cacheReadTokens = cacheRead;
					summary.cacheCreationTokens = cacheCreation;

					return;
				}
				case 'content_block_start':
					if (event.content_block?.type === 'tool_use') {
						summary.toolNames.push(event.content_block.name);
						summary.firstTokenAt ??= Date.now();
					}

					return;
				case 'content_block_delta':
					if (event.delta?.type === 'text_delta') summary.firstTokenAt ??= Date.now();
					if (event.delta?.type === 'thinking_delta') {
						summary.firstTokenAt ??= Date.now();
						summary.reasoningChars = (summary.reasoningChars ?? 0) + (event.delta.thinking?.length ?? 0);
					}

					return;
				case 'message_delta':
					if (event.delta?.stop_reason) rawStopReason = event.delta.stop_reason;
					if (event.usage) summary.outputTokens = event.usage.output_tokens ?? summary.outputTokens;

					return;
				case 'message_stop':
					sawMessageStop = true;

					return;
				case 'error':
					streamError = event.error?.message ?? event.error?.type ?? 'Upstream stream error';
					if (!errorReported) {
						errorReported = true;
						hooks.onError?.(event.error as Record<string, unknown> | undefined);
					}

					return;
				default:
			}
		};

		const scan = (text: string) => {
			buffer += text;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				try {
					handle(JSON.parse(line.slice(5).trim()) as AnthropicStreamEvent);
				} catch {
					// Not JSON: the bytes are still forwarded; only the summary skips it.
				}
			}
			if (buffer.length > MAX_CARRY) buffer = '';
		};

		const end = (cause: 'complete' | 'aborted' | 'failed', failure?: unknown) => {
			if (ended) return;
			ended = true;

			if (streamError !== null) {
				summary.stopReason = 'error';
				summary.error = streamError;
			} else if (cause === 'aborted') {
				summary.stopReason = 'aborted';
				summary.error = 'Client cancelled stream';
			} else if (cause === 'failed') {
				summary.stopReason = 'error';
				summary.error = `Upstream stream failed: ${String(failure)}`;
			} else if (!sawMessageStop) {
				summary.stopReason = 'error';
				summary.error = 'Upstream stream ended before message_stop';
			} else {
				summary.stopReason = RequestHeuristics.normalizeStopReason(rawStopReason);
			}

			hooks.onEnd(summary);
		};

		return new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						scan(decoder.decode());
						end('complete');
						controller.close();

						return;
					}
					controller.enqueue(value);
					scan(decoder.decode(value, { stream: true }));
				} catch (error) {
					end('failed', error);
					controller.error(error);
				}
			},
			cancel(reason) {
				end('aborted');

				return reader.cancel(reason).catch(() => undefined);
			}
		});
	}
}
