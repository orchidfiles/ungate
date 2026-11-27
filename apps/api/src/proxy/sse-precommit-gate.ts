import { logger } from 'src/utils/logger';

import { OAuthAccounts } from '../database/oauth-accounts';
import { UsageFetcher } from '../usage/usage-fetcher';

import { AccountFallback, type InspectedAttempt } from './account-fallback';
import { UsageLimitClassifier } from './usage-limit-classifier';

import type { SubscriptionProvider } from '@ungate/shared';

/**
 * Bounded pre-commit inspection of a successful (HTTP 200) SSE response.
 *
 * Nothing has been sent downstream yet, so an explicit usage-limit error that arrives before any
 * substantive output can still rotate accounts. The gate reads SSE events until the first
 * decisive one (text/reasoning/tool output, a terminal event, or an error), or until a byte/time
 * bound, then "commits": it returns a replacement response that replays the exact bytes it read
 * followed by the rest of the upstream body. After commit the request is never replayed.
 *
 * Recognized usage-limit errors rotate. Early transient errors (overloaded / server error) are
 * reported as `transient` so the coordinator can retry before commit. Any other early error is
 * committed unchanged so the downstream stream handler reports it.
 */
export interface SseGateOptions {
	/** Stop inspecting after this many bytes (default 64 KiB). */
	maxBytes?: number;
	/** Stop inspecting after this long without a decisive event (default 10 s). */
	maxMs?: number;
	signal?: AbortSignal;
	now?: () => number;
}

export const SSE_GATE_MAX_BYTES = 64 * 1024;
export const SSE_GATE_MAX_MS = 10_000;

type Decision =
	| { kind: 'continue' }
	| { kind: 'commit'; why: string }
	| { kind: 'error'; error: Record<string, unknown> | undefined };

const CONTINUE: Decision = { kind: 'continue' };

/** Anthropic events that are not yet user-visible output. */
const ANTHROPIC_PREAMBLE = new Set(['message_start', 'ping']);
/** Codex `/responses` events that are not yet user-visible output. */
const CODEX_PREAMBLE = new Set(['response.created', 'response.in_progress', 'response.queued', 'response.content_part.added']);
const CODEX_TOOL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function decideAnthropic(event: Record<string, unknown>): Decision {
	const type = event.type;
	if (type === 'error') return { kind: 'error', error: record(event.error) };
	if (typeof type !== 'string' || ANTHROPIC_PREAMBLE.has(type)) return CONTINUE;
	// An empty text/thinking block start is not output yet; a tool_use start is.
	if (type === 'content_block_start') {
		const blockType = record(event.content_block)?.type;

		return blockType === 'text' || blockType === 'thinking' || blockType === 'redacted_thinking'
			? CONTINUE
			: { kind: 'commit', why: `content_block_start:${String(blockType)}` };
	}

	return { kind: 'commit', why: type };
}

function decideCodex(event: Record<string, unknown>): Decision {
	const type = event.type;
	if (type === 'error') return { kind: 'error', error: record(event.error) ?? event };
	if (type === 'response.failed') return { kind: 'error', error: record(record(event.response)?.error) };
	if (typeof type !== 'string' || CODEX_PREAMBLE.has(type)) return CONTINUE;
	if (type === 'response.output_item.added') {
		const itemType = record(event.item)?.type;

		return typeof itemType === 'string' && CODEX_TOOL_ITEMS.has(itemType)
			? { kind: 'commit', why: `output_item:${itemType}` }
			: CONTINUE;
	}

	return { kind: 'commit', why: type };
}

/** Incremental SSE event splitter: yields the parsed JSON `data:` payload of each complete event. */
class SseEventParser {
	private buffer = '';
	private readonly decoder = new TextDecoder();

	push(chunk: Uint8Array): Record<string, unknown>[] {
		this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
		const parts = this.buffer.split('\n\n');
		this.buffer = parts.pop() ?? '';
		const events: Record<string, unknown>[] = [];

		for (const part of parts) {
			const data = part
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).replace(/^ /, ''))
				.join('\n');
			if (!data || data === '[DONE]') continue;
			try {
				const parsed = record(JSON.parse(data));
				if (parsed) events.push(parsed);
			} catch {
				// Malformed data line: not decisive.
			}
		}

		return events;
	}
}

/** Early stream errors that mean "the upstream is struggling, try again": Anthropic `overloaded_error` / `api_error`, Codex `server_error`. */
const TRANSIENT_STREAM_ERRORS = new Set(['overloaded_error', 'api_error', 'server_error']);

function transientStreamError(error: Record<string, unknown> | undefined): string | undefined {
	for (const value of [error?.type, error?.code]) {
		if (typeof value === 'string' && TRANSIENT_STREAM_ERRORS.has(value)) return value;
	}

	return undefined;
}

function isEventStream(response: Response): boolean {
	return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

export class SsePrecommitGate {
	/** `inspect` hook for `AccountFallback.run`: HTTP-level classification first, then the SSE gate. */
	static inspector(
		provider: SubscriptionProvider,
		options: SseGateOptions = {}
	): (response: Response) => Promise<InspectedAttempt> {
		return (response) => this.inspect(provider, response, options);
	}

	static async inspect(
		provider: SubscriptionProvider,
		response: Response,
		options: SseGateOptions = {}
	): Promise<InspectedAttempt> {
		const http = await AccountFallback.inspectHttp(provider, response);
		if (http.limit || http.response !== response || response.status !== 200 || !response.body || !isEventStream(response)) {
			return http;
		}

		const maxBytes = options.maxBytes ?? SSE_GATE_MAX_BYTES;
		const maxMs = options.maxMs ?? SSE_GATE_MAX_MS;
		const now = options.now ?? Date.now;
		const decide = provider === 'openai' ? decideCodex : decideAnthropic;
		const reader = response.body.getReader();
		const parser = new SseEventParser();
		const buffered: Uint8Array[] = [];
		const deadline = now() + maxMs;
		let size = 0;
		let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
		let ended = false;
		let why = 'bound';

		const abort = () => {
			void reader.cancel(options.signal?.reason).catch(() => undefined);
		};
		options.signal?.addEventListener('abort', abort, { once: true });

		try {
			inspect: while (size < maxBytes) {
				options.signal?.throwIfAborted();
				const remaining = deadline - now();
				if (remaining <= 0) {
					why = 'time_bound';
					break;
				}
				pending ??= reader.read();
				const result = await this.raceTimeout(pending, remaining);
				if (result === 'timeout') {
					why = 'time_bound';
					break;
				}
				pending = undefined;
				options.signal?.throwIfAborted();
				if (result.done) {
					ended = true;
					why = 'eof';
					break;
				}
				buffered.push(result.value);
				size += result.value.byteLength;

				for (const event of parser.push(result.value)) {
					const decision = decide(event);
					if (decision.kind === 'continue') continue;
					if (decision.kind === 'commit') {
						why = decision.why;
						break inspect;
					}

					const limit = UsageLimitClassifier.classifyStreamError(provider, response.headers, decision.error);
					if (limit.kind === 'usage_limit') {
						logger.log(`[accounts] ${provider} early SSE usage-limit error before output (${limit.reason})`);
						await reader.cancel().catch(() => undefined);

						return { response, limit };
					}
					const transient = transientStreamError(decision.error);
					if (transient) {
						logger.log(`[accounts] ${provider} early SSE transient error before output (${transient})`);
						await reader.cancel().catch(() => undefined);

						// If no retry is left, the client still sees the upstream's error event.
						return { response: this.replay(response, reader, buffered, undefined, true), transient: `sse_${transient}` };
					}
					// Unknown early error: never rotates; the downstream handler reports it.
					why = `error:${limit.reason}`;
					break inspect;
				}
			}
			if (size >= maxBytes && why === 'bound') why = 'byte_bound';
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw error;
		} finally {
			options.signal?.removeEventListener('abort', abort);
		}

		logger.log(`[accounts] ${provider} SSE committed after ${size} bytes (${why})`);

		return { response: this.replay(response, reader, buffered, pending, ended) };
	}

	/**
	 * Post-commit hook: an error that arrives after the response was handed downstream is never
	 * retried, but a recognized usage limit still cools down the serving account (pinned to the
	 * credential generation that served it) so later requests switch.
	 */
	static cooldownOnStreamLimit(
		provider: SubscriptionProvider,
		accountId: string,
		credentialVersion: number | undefined,
		headers: Headers
	): (error: Record<string, unknown> | undefined) => void {
		let handled = false;

		return (error) => {
			if (handled) return;
			handled = true;
			const limit = UsageLimitClassifier.classifyStreamError(provider, headers, error);
			if (limit.kind !== 'usage_limit') return;
			const until = limit.resetAt ?? Date.now();
			if (OAuthAccounts.markCooldown(accountId, until, limit.reason, limit.estimated, credentialVersion)) {
				UsageFetcher.refreshAfterCooldown(provider, accountId);
			}
			logger.log(
				`[accounts] ${provider} account ${accountId} usage limit after stream commit (${limit.reason}); no retry, cooldown until ${new Date(until).toISOString()}`
			);
		};
	}

	/** Response that replays `buffered` byte-for-byte, then the rest of the upstream stream. */
	private static replay(
		response: Response,
		reader: ReadableStreamDefaultReader<Uint8Array>,
		buffered: Uint8Array[],
		pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined,
		ended: boolean
	): Response {
		let index = 0;
		let carry = pending;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (index < buffered.length) {
					controller.enqueue(buffered[index++]);

					return;
				}
				if (ended) {
					controller.close();

					return;
				}
				try {
					const result = await (carry ?? reader.read());
					carry = undefined;
					if (result.done) {
						ended = true;
						controller.close();
					} else {
						controller.enqueue(result.value);
					}
				} catch (error) {
					controller.error(error);
				}
			},
			cancel(reason) {
				return reader.cancel(reason).catch(() => undefined);
			}
		});

		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: AccountFallback.sanitizeHeaders(response.headers)
		});
	}

	private static raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), ms);
		});

		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}
}
