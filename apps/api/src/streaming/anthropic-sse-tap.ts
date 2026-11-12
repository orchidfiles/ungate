import { RequestHeuristics } from '../metrics/request-heuristics';

import { tapSse, type SseTapEnd, type SseTapReader } from './sse-tap';

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

/** Reads Anthropic stream events into an `AnthropicStreamSummary`. */
class AnthropicStreamReader implements SseTapReader<AnthropicStreamSummary> {
	private buffer = '';
	private sawMessageStop = false;
	private rawStopReason: string | null = null;
	private streamError: string | null = null;
	private errorReported = false;
	private readonly summary: AnthropicStreamSummary = {
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

	constructor(private readonly onError?: AnthropicSseTapHooks['onError']) {}

	read(text: string): void {
		this.buffer += text;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.startsWith('data:')) continue;
			try {
				this.handle(JSON.parse(line.slice(5).trim()) as AnthropicStreamEvent);
			} catch {
				// Not JSON: the bytes are still forwarded; only the summary skips it.
			}
		}
		if (this.buffer.length > MAX_CARRY) this.buffer = '';
	}

	finish(end: SseTapEnd): AnthropicStreamSummary {
		const summary = this.summary;
		if (this.streamError !== null) {
			summary.stopReason = 'error';
			summary.error = this.streamError;
		} else if (end.kind === 'aborted') {
			summary.stopReason = 'aborted';
			summary.error = 'Client cancelled stream';
		} else if (end.kind === 'failed') {
			summary.stopReason = 'error';
			summary.error = `Upstream stream failed: ${String(end.error)}`;
		} else if (!this.sawMessageStop) {
			summary.stopReason = 'error';
			summary.error = 'Upstream stream ended before message_stop';
		} else {
			summary.stopReason = RequestHeuristics.normalizeStopReason(this.rawStopReason);
		}

		return summary;
	}

	private handle(event: AnthropicStreamEvent): void {
		const summary = this.summary;
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
				if (event.delta?.stop_reason) this.rawStopReason = event.delta.stop_reason;
				if (event.usage) summary.outputTokens = event.usage.output_tokens ?? summary.outputTokens;

				return;
			case 'message_stop':
				this.sawMessageStop = true;

				return;
			case 'error':
				this.streamError = event.error?.message ?? event.error?.type ?? 'Upstream stream error';
				if (!this.errorReported) {
					this.errorReported = true;
					this.onError?.(event.error as Record<string, unknown> | undefined);
				}

				return;
			default:
		}
	}
}

/**
 * Byte-for-byte passthrough of an Anthropic SSE body that reads usage, stop reason, tool names and
 * `error` events as they pass. Downstream cancellation cancels the upstream body.
 */
export class AnthropicSseTap {
	static observe(body: ReadableStream<Uint8Array>, hooks: AnthropicSseTapHooks): ReadableStream<Uint8Array> {
		return tapSse(body, new AnthropicStreamReader(hooks.onError), hooks.onEnd);
	}
}
