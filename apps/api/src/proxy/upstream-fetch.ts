/** The upstream accepted the connection but sent no response headers in time. */
export class UpstreamHeadersTimeout extends Error {
	constructor(readonly timeoutMs: number) {
		super(`upstream sent no response headers within ${Math.round(timeoutMs / 1000)}s`);
		this.name = 'UpstreamHeadersTimeout';
	}
}

/**
 * Longest wait for response headers. A stream sends its headers before the model starts work; a
 * buffered (non-stream) reply sends them only when the whole answer is ready, so it gets longer.
 */
export const HEADERS_TIMEOUT_MS = { stream: 90_000, buffered: 600_000 } as const;

/**
 * `fetch` that fails with `UpstreamHeadersTimeout` when no headers arrive within `timeoutMs`. The
 * timer stops once headers arrive, so a long body is never cut by it; `signal` (the client's
 * cancellation) still aborts the request and its body at any time.
 */
export async function fetchWithHeadersTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal
): Promise<Response> {
	const headers = new AbortController();
	const timeout = new UpstreamHeadersTimeout(timeoutMs);
	const timer = setTimeout(() => headers.abort(timeout), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, headers.signal]) : headers.signal });
	} catch (error) {
		if (headers.signal.aborted && !signal?.aborted) throw timeout;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
