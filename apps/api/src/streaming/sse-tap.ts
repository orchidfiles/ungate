import { logger } from 'src/utils/logger';

/** How a tapped stream ended. */
export type SseTapEnd = { kind: 'complete' } | { kind: 'aborted' } | { kind: 'failed'; error: unknown };

/** Reads a provider's events as they pass and turns the end of the stream into a summary. */
export interface SseTapReader<S> {
	/** Decoded text in arrival order; events may be split across calls. */
	read(text: string): void;
	finish(end: SseTapEnd): S;
}

/**
 * Longest an upstream stream may stay silent (no bytes at all) before it is cut. Anthropic pings
 * and Codex progress events keep a working stream well inside it; a dead connection does not.
 */
export const UPSTREAM_IDLE_TIMEOUT_MS = 180_000;

/** The upstream sent nothing for `idleMs`. */
export class UpstreamIdle extends Error {
	constructor(readonly idleMs: number) {
		super(`upstream idle for ${Math.round(idleMs / 1000)}s`);
		this.name = 'UpstreamIdle';
	}
}

/**
 * The next chunk from `reader`, or a rejection with `UpstreamIdle` when none arrives within `ms`
 * (0 waits forever). On idle the read stays pending; the caller cancels the reader, which settles it.
 */
export async function readWithin<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<ReadableStreamReadResult<T>> {
	if (ms <= 0) return reader.read();
	let timer: NodeJS.Timeout | undefined;
	const idle = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new UpstreamIdle(ms)), ms);
	});
	try {
		return await Promise.race([reader.read(), idle]);
	} finally {
		clearTimeout(timer);
	}
}

/** The server is shutting down and its drain window ran out while this stream was still open. */
export class ServerDraining extends Error {
	constructor() {
		super('server shutting down');
		this.name = 'ServerDraining';
	}
}

/** Why a tapped stream was ended early with a terminal event. */
export type StreamCut = UpstreamIdle | ServerDraining;

/** Client-facing message for a cut stream. */
export function cutMessage(cut: StreamCut): string {
	return cut instanceof UpstreamIdle ? `Upstream stream stalled: ${cut.message}` : 'Ungate is restarting; retry the request';
}

/**
 * Cuts a silent upstream (or one still open when the server finishes draining) and tells the
 * client, in the provider's own terms, that the stream failed.
 */
export interface SseIdleWatchdog {
	/** Longest wait for the next upstream chunk; 0 disables the idle cut. */
	idleTimeoutMs: number;
	/** One complete SSE frame the client reads as a terminal failure. */
	terminalEvent: (cut: StreamCut) => string;
}

/** Cutters of the tapped streams now open; `cutOpenStreams` ends them all. */
const openStreams = new Set<(cut: ServerDraining) => void>();

/** Number of tapped streams still open. */
export function openStreamCount(): number {
	return openStreams.size;
}

/** Ends every open tapped stream with its provider's terminal event (server shutdown). */
export function cutOpenStreams(): number {
	const count = openStreams.size;
	const cut = new ServerDraining();
	for (const end of [...openStreams]) end(cut);

	return count;
}

/**
 * Byte-for-byte passthrough of an SSE body that lets `reader` see each chunk. `onEnd` runs exactly
 * once, when the stream completes, fails or the downstream client cancels; a cancel also cancels the
 * upstream body. With a `watchdog`, an upstream silent for its timeout is cancelled and the stream
 * ends with the watchdog's terminal event instead of hanging.
 */
export function tapSse<S>(
	body: ReadableStream<Uint8Array>,
	reader: SseTapReader<S>,
	onEnd: (summary: S) => void,
	watchdog?: SseIdleWatchdog
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const upstream = body.getReader();
	let ended = false;
	/** Rejects when shutdown cuts this stream; raced against every upstream read. */
	let rejectCut: ((cut: ServerDraining) => void) | undefined;
	const cutRequested = new Promise<never>((_, reject) => {
		rejectCut = reject;
	});
	cutRequested.catch(() => undefined);
	const cutter = (cut: ServerDraining) => rejectCut?.(cut);
	if (watchdog) openStreams.add(cutter);

	const end = (how: SseTapEnd) => {
		if (ended) return;
		ended = true;
		openStreams.delete(cutter);
		onEnd(reader.finish(how));
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await Promise.race([readWithin(upstream, watchdog?.idleTimeoutMs ?? 0), cutRequested]);
				if (done) {
					reader.read(decoder.decode());
					end({ kind: 'complete' });
					controller.close();

					return;
				}
				controller.enqueue(value);
				reader.read(decoder.decode(value, { stream: true }));
			} catch (error) {
				if ((error instanceof UpstreamIdle || error instanceof ServerDraining) && watchdog) {
					logger.error(`Cutting SSE stream: ${error.message}`);
					void upstream.cancel(error).catch(() => undefined);
					// A leading blank line closes any event the upstream left half-sent.
					controller.enqueue(new TextEncoder().encode(`\n\n${watchdog.terminalEvent(error)}`));
					end({ kind: 'failed', error });
					controller.close();

					return;
				}
				end({ kind: 'failed', error });
				controller.error(error);
			}
		},
		cancel(reason) {
			end({ kind: 'aborted' });

			return upstream.cancel(reason).catch(() => undefined);
		}
	});
}
