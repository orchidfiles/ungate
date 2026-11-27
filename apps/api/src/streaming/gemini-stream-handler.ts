import { randomUUID } from 'node:crypto';

import { Requests } from 'src/database/requests';
import { logger } from 'src/utils/logger';

import type { RequestTelemetry, StopReason } from '@ungate/shared';
import type { OpenAIToolCall } from 'src/types/openai';
import type { RequestContext } from 'src/types/proxy';

/**
 * Code Assist `streamGenerateContent?alt=sse` → OpenAI `chat.completion.chunk`s.
 *
 * Each SSE event is `{ response: { candidates: [{ content: { parts }, finishReason }], usageMetadata } }`.
 * Parts carry `text` (answer), `text` + `thought: true` (reasoning summary) or a complete
 * `functionCall` (`{ id?, name, args }`; Gemini never streams argument fragments). A
 * google.rpc status `{ error }` event is a post-commit upstream error. The stream has no terminal
 * marker of its own: the last candidate carries `finishReason`.
 */

type OpenAiFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export type GeminiStreamResult =
	| { type: 'chunk'; data: Record<string, unknown> }
	| { type: 'error'; data: Record<string, unknown>; upstreamError: Record<string, unknown> | undefined };

export interface GeminiUsage {
	promptTokens: number;
	/** Visible output plus thoughts (what OpenAI `completion_tokens` counts). */
	completionTokens: number;
	thoughtsTokens: number | null;
	cachedTokens: number | null;
}

const CONTENT_FILTER_REASONS = new Set([
	'SAFETY',
	'RECITATION',
	'BLOCKLIST',
	'PROHIBITED_CONTENT',
	'SPII',
	'IMAGE_SAFETY',
	'LANGUAGE'
]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class GeminiStreamConverter {
	readonly id = `chatcmpl-${randomUUID()}`;
	readonly created = Math.floor(Date.now() / 1000);
	text = '';
	reasoningChars = 0;
	toolCalls: OpenAIToolCall[] = [];
	usage: GeminiUsage | null = null;
	/** Raw upstream `finishReason` of the last candidate, once seen. */
	upstreamFinish: string | null = null;
	failure: { message: string; type: string; code?: string; upstream?: Record<string, unknown> } | null = null;
	firstTokenAt: number | null = null;
	private buffer = '';
	private roleSent = false;

	constructor(private readonly model: string) {}

	get toolNames(): string[] {
		return this.toolCalls.map((call) => call.function.name);
	}

	get finished(): boolean {
		return this.upstreamFinish !== null || this.failure !== null;
	}

	get finishReason(): OpenAiFinishReason {
		if (this.toolCalls.length) return 'tool_calls';
		if (this.upstreamFinish === 'MAX_TOKENS') return 'length';
		if (this.upstreamFinish && CONTENT_FILTER_REASONS.has(this.upstreamFinish)) return 'content_filter';

		return 'stop';
	}

	/** Feeds decoded SSE text; returns the OpenAI chunks it completes. */
	push(text: string): GeminiStreamResult[] {
		this.buffer += text.replace(/\r\n/g, '\n');
		const events = this.buffer.split('\n\n');
		this.buffer = events.pop() ?? '';

		return events.flatMap((event) => this.event(event));
	}

	/** Flushes a trailing event that arrived without its blank-line terminator. */
	flush(): GeminiStreamResult[] {
		const rest = this.buffer;
		this.buffer = '';

		return rest.trim() ? this.event(rest) : [];
	}

	/** Final chunk with `finish_reason` and usage; call once after a successful upstream finish. */
	finalChunk(): Record<string, unknown> {
		return { ...this.chunk({}, this.finishReason), usage: this.openAiUsage() };
	}

	openAiUsage(): Record<string, unknown> {
		const usage = this.usage;
		const prompt = usage?.promptTokens ?? 0;
		const completion = usage?.completionTokens ?? 0;

		return {
			prompt_tokens: prompt,
			completion_tokens: completion,
			total_tokens: prompt + completion,
			...(usage?.cachedTokens != null ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } } : {}),
			...(usage?.thoughtsTokens != null ? { completion_tokens_details: { reasoning_tokens: usage.thoughtsTokens } } : {})
		};
	}

	telemetry(override?: 'failed' | 'aborted'): RequestTelemetry {
		let stopReason: StopReason;
		if (override === 'aborted') stopReason = 'aborted';
		else if (override === 'failed' || this.failure || !this.upstreamFinish) stopReason = 'error';
		else if (this.toolCalls.length) stopReason = 'tool_use';
		else if (this.upstreamFinish === 'MAX_TOKENS') stopReason = 'max_tokens';
		else if (CONTENT_FILTER_REASONS.has(this.upstreamFinish)) stopReason = 'error';
		else stopReason = 'end_turn';

		return {
			stopReason,
			toolCallCount: this.toolCalls.length,
			toolNames: this.toolNames,
			cacheReadTokens: this.usage?.cachedTokens ?? (this.usage ? 0 : null),
			// Code Assist reports no cache writes; implicit caching is free.
			cacheCreationTokens: this.usage ? 0 : null,
			reasoningTokens: this.usage?.thoughtsTokens ?? null,
			reasoningChars: this.reasoningChars || null
		};
	}

	/** Non-streaming `chat.completion` built from everything converted so far. */
	completion(): Record<string, unknown> {
		return {
			id: this.id,
			object: 'chat.completion',
			created: this.created,
			model: this.model,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: this.text || null,
						...(this.toolCalls.length ? { tool_calls: this.toolCalls } : {})
					},
					finish_reason: this.finishReason
				}
			],
			usage: this.openAiUsage()
		};
	}

	private event(raw: string): GeminiStreamResult[] {
		const data = raw
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).replace(/^ /, ''))
			.join('\n');
		if (!data || data === '[DONE]') return [];
		let parsed: Record<string, unknown> | undefined;
		try {
			parsed = record(JSON.parse(data));
		} catch {
			logger.log(`[Gemini stream] skipped malformed SSE data (${data.length} chars)`);

			return [];
		}
		if (!parsed) return [];

		const error = record(parsed.error);
		if (error) return [this.error(error)];

		const response = record(parsed.response) ?? parsed;
		this.recordUsage(record(response.usageMetadata));
		const candidate = (Array.isArray(response.candidates) ? response.candidates : []).map(record)[0];
		if (!candidate) return [];

		const results: GeminiStreamResult[] = [];
		const parts = record(candidate.content)?.parts;
		for (const part of Array.isArray(parts) ? parts.map(record) : []) {
			if (!part) continue;
			const delta = this.partDelta(part);
			if (delta) results.push({ type: 'chunk', data: this.chunk(delta, null) });
		}
		if (typeof candidate.finishReason === 'string' && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
			this.upstreamFinish = candidate.finishReason;
		}

		return results;
	}

	private partDelta(part: Record<string, unknown>): Record<string, unknown> | null {
		const call = record(part.functionCall);
		if (call && typeof call.name === 'string' && call.name) {
			const index = this.toolCalls.length;
			const toolCall: OpenAIToolCall = {
				id: typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
				type: 'function',
				function: { name: call.name, arguments: JSON.stringify(record(call.args) ?? {}) }
			};
			this.toolCalls.push(toolCall);
			this.markFirstToken();

			return { tool_calls: [{ index, ...toolCall }] };
		}

		// `thought` is a boolean flag on a text part; older payloads put the text in `thought` itself.
		const thought = part.thought === true ? part.text : typeof part.thought === 'string' ? part.thought : undefined;
		if (typeof thought === 'string') {
			if (!thought) return null;
			this.reasoningChars += thought.length;
			this.markFirstToken();

			return { reasoning_content: thought };
		}
		if (typeof part.text === 'string' && part.text) {
			this.text += part.text;
			this.markFirstToken();

			return { content: part.text };
		}

		return null;
	}

	private error(error: Record<string, unknown>): GeminiStreamResult {
		const message = typeof error.message === 'string' && error.message ? error.message : 'Gemini stream error';
		const status = typeof error.status === 'string' ? error.status : undefined;
		const type = error.code === 429 || status === 'RESOURCE_EXHAUSTED' ? 'rate_limit_error' : 'api_error';
		this.failure = { message, type, ...(status ? { code: status.toLowerCase() } : {}), upstream: error };

		return {
			type: 'error',
			data: { error: { message, type, ...(status ? { code: status.toLowerCase() } : {}) } },
			upstreamError: error
		};
	}

	private recordUsage(metadata: Record<string, unknown> | undefined): void {
		if (!metadata) return;
		const prompt = count(metadata.promptTokenCount);
		const candidates = count(metadata.candidatesTokenCount);
		const thoughts = count(metadata.thoughtsTokenCount);
		if (prompt === undefined && candidates === undefined && thoughts === undefined) return;
		// Each event repeats the running totals; the last one wins.
		this.usage = {
			promptTokens: prompt ?? this.usage?.promptTokens ?? 0,
			completionTokens: (candidates ?? 0) + (thoughts ?? 0),
			thoughtsTokens: thoughts ?? null,
			cachedTokens: count(metadata.cachedContentTokenCount) ?? null
		};
	}

	private markFirstToken(): void {
		this.firstTokenAt ??= Date.now();
	}

	private chunk(delta: Record<string, unknown>, finishReason: OpenAiFinishReason | null): Record<string, unknown> {
		const withRole = this.roleSent ? delta : { role: 'assistant', ...delta };
		this.roleSent = true;

		return {
			id: this.id,
			object: 'chat.completion.chunk',
			created: this.created,
			model: this.model,
			choices: [{ index: 0, delta: withRole, finish_reason: finishReason }]
		};
	}
}

export class GeminiStreamHandler {
	/**
	 * Converts the committed Code Assist SSE body into an OpenAI SSE stream. A post-commit upstream
	 * error is forwarded as an error event without `[DONE]` (and reported to `onStreamError` so a
	 * usage limit cools the account down); a stream that ends without a `finishReason` is reported as
	 * incomplete. Records exactly one analytics row when the stream ends.
	 */
	static createStreamResponse(
		response: Response,
		converter: GeminiStreamConverter,
		context: RequestContext,
		onStreamError: (error: Record<string, unknown> | undefined) => void
	): Response {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let cancelled = false;
		let recorded = false;

		const recordOutcome = (error?: string, aborted = false) => {
			if (recorded) return;
			recorded = true;
			const usage = converter.usage;
			Requests.record({
				...context.telemetry,
				...converter.telemetry(aborted ? 'aborted' : error ? 'failed' : undefined),
				model: context.model,
				source: error ? 'error' : context.source,
				inputTokens: usage?.promptTokens ?? 0,
				outputTokens: usage?.completionTokens ?? 0,
				stream: true,
				latencyMs: Date.now() - context.startTime,
				firstTokenMs: converter.firstTokenAt ? converter.firstTokenAt - context.startTime : null,
				error: error?.slice(0, 500) ?? null
			});
		};

		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				const emit = (text: string) => {
					if (!cancelled) controller.enqueue(encoder.encode(text));
				};
				const forward = (results: GeminiStreamResult[]) => {
					for (const result of results) {
						if (result.type === 'error') onStreamError(result.upstreamError);
						emit(`data: ${JSON.stringify(result.data)}\n\n`);
					}
				};

				try {
					while (!cancelled && !converter.failure) {
						const { done, value } = await reader.read();
						if (done || cancelled) break;
						forward(converter.push(decoder.decode(value, { stream: true })));
					}
					if (cancelled) return;
					if (!converter.failure) forward(converter.flush());

					if (converter.failure) {
						recordOutcome(converter.failure.message);
					} else if (!converter.upstreamFinish) {
						const message = 'Gemini stream ended before completion';
						logger.error(`[Gemini] ${message}`);
						emit(`data: ${JSON.stringify({ error: { message, type: 'api_error', code: 'stream_incomplete' } })}\n\n`);
						recordOutcome(message);
					} else {
						emit(`data: ${JSON.stringify(converter.finalChunk())}\n\n`);
						emit('data: [DONE]\n\n');
						recordOutcome();
					}
					controller.close();
				} catch (error) {
					if (cancelled) return;
					logger.error(`[Gemini] stream processing failed: ${String(error)}`);
					recordOutcome(`Stream processing failed: ${String(error)}`);
					controller.error(error);
				} finally {
					await reader.cancel().catch(() => undefined);
				}
			},
			cancel(reason) {
				cancelled = true;
				logger.log(`[Gemini] downstream cancelled stream: ${String(reason)}`);
				recordOutcome('Client cancelled stream', true);

				return reader.cancel(reason).catch(() => undefined);
			}
		});

		return new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
		});
	}

	/** Reads the whole committed SSE body into `converter`; returns false when it failed or was cut short. */
	static async drain(
		response: Response,
		converter: GeminiStreamConverter,
		onStreamError: (error: Record<string, unknown> | undefined) => void
	): Promise<boolean> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		const report = (results: GeminiStreamResult[]) => {
			for (const result of results) if (result.type === 'error') onStreamError(result.upstreamError);
		};
		try {
			while (!converter.failure) {
				const { done, value } = await reader.read();
				if (done) break;
				report(converter.push(decoder.decode(value, { stream: true })));
			}
			if (!converter.failure) report(converter.flush());
		} finally {
			await reader.cancel().catch(() => undefined);
		}

		return !converter.failure && converter.upstreamFinish !== null;
	}
}
