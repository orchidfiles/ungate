import * as http2 from 'node:http2';
import * as zlib from 'node:zlib';

/** Connect envelope flag bits. */
export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;

/** One decoded frame never needs more than this; anything bigger is a protocol error. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Headers that HTTP/2 forbids or that must never be forwarded from the header helper. */
const FORBIDDEN_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'te']);

export class CursorOriginError extends Error {
	constructor() {
		super('Refusing to connect to a non-Cursor origin');
		this.name = 'CursorOriginError';
	}
}

export class ConnectProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConnectProtocolError';
	}
}

/** Only `https://cursor.sh` and its subdomains are reachable; returns the normalized origin. */
export function assertCursorOrigin(rawUrl: string): string {
	let url: URL;

	try {
		url = new URL(rawUrl);
	} catch {
		throw new CursorOriginError();
	}

	const host = url.hostname.toLowerCase();
	const allowedHost = host === 'cursor.sh' || host.endsWith('.cursor.sh');

	if (url.protocol !== 'https:' || !allowedHost || url.username || url.password) {
		throw new CursorOriginError();
	}

	return url.origin;
}

export function encodeEnvelope(message: unknown, flags = 0): Buffer {
	const payload = Buffer.from(JSON.stringify(message), 'utf8');
	const header = Buffer.alloc(5);
	header.writeUInt8(flags, 0);
	header.writeUInt32BE(payload.length, 1);

	return Buffer.concat([header, payload]);
}

export interface ConnectFrame {
	flags: number;
	/** Parsed JSON payload. */
	message: unknown;
}

/** Incremental Connect envelope decoder: tolerates frames split across any chunk boundary. */
export class ConnectFrameDecoder {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): ConnectFrame[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const frames: ConnectFrame[] = [];

		while (this.buffer.length >= 5) {
			const flags = this.buffer.readUInt8(0);
			const length = this.buffer.readUInt32BE(1);

			if (length > MAX_FRAME_BYTES) {
				throw new ConnectProtocolError('Connect frame exceeds size limit');
			}

			if (this.buffer.length < 5 + length) {
				break;
			}

			let payload = this.buffer.subarray(5, 5 + length);
			this.buffer = this.buffer.subarray(5 + length);

			if (flags & CONNECT_FLAG_COMPRESSED) {
				payload = zlib.gunzipSync(payload, { maxOutputLength: MAX_FRAME_BYTES });
			}

			const text = payload.toString('utf8');
			let message: unknown;

			try {
				message = text.length === 0 ? {} : JSON.parse(text);
			} catch {
				throw new ConnectProtocolError('Connect frame is not valid JSON');
			}

			frames.push({ flags, message });
		}

		return frames;
	}

	/** Bytes left over after the stream ended; a non-zero value means a truncated frame. */
	pendingBytes(): number {
		return this.buffer.length;
	}
}

export function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};

	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase();

		if (lower.startsWith(':') || FORBIDDEN_HEADERS.has(lower) || typeof value !== 'string') {
			continue;
		}

		out[lower] = value;
	}

	return out;
}

export type Http2Connect = (authority: string) => http2.ClientHttp2Session;

export interface BidiStreamOptions {
	url: string;
	path: string;
	headers: Record<string, string>;
	signal?: AbortSignal;
	/** Whole-stream deadline. */
	deadlineMs: number;
	connect?: Http2Connect;
}

export type BidiStreamItem =
	| { type: 'status'; status: number }
	| { type: 'frame'; frame: ConnectFrame }
	| { type: 'closed' }
	| { type: 'error'; error: Error };

export interface BidiStream {
	write(message: unknown): void;
	end(): void;
	close(): void;
	items(): AsyncIterable<BidiStreamItem>;
}

/** Opens a bidirectional Connect-JSON stream over HTTP/2 to an allowlisted Cursor origin. */
export function openBidiStream(options: BidiStreamOptions): BidiStream {
	const origin = assertCursorOrigin(options.url);
	const connect = options.connect ?? ((authority: string) => http2.connect(authority));
	const session = connect(origin);
	const queue: BidiStreamItem[] = [];
	let notify: (() => void) | null = null;
	let finished = false;
	const decoder = new ConnectFrameDecoder();

	const push = (item: BidiStreamItem) => {
		if (finished) return;
		if (item.type === 'closed' || item.type === 'error') finished = true;
		queue.push(item);
		notify?.();
		notify = null;
	};

	session.on('error', (error: Error) => push({ type: 'error', error }));

	const stream = session.request(
		{
			...sanitizeRequestHeaders(options.headers),
			':method': 'POST',
			':path': options.path,
			'content-type': 'application/connect+json',
			'connect-protocol-version': '1',
			'connect-timeout-ms': String(options.deadlineMs)
		},
		{ endStream: false }
	);

	const deadline = setTimeout(() => {
		push({ type: 'error', error: new ConnectProtocolError('deadline_exceeded') });
		close();
	}, options.deadlineMs);

	// Abort only notifies the consumer: it still has to write `cancelInvocation` / `finishRun` before it calls `close()`.
	const onAbort = () => {
		push({ type: 'error', error: new ConnectProtocolError('aborted') });
	};

	options.signal?.addEventListener('abort', onAbort, { once: true });

	function close(): void {
		clearTimeout(deadline);
		options.signal?.removeEventListener('abort', onAbort);

		try {
			stream.close(http2.constants.NGHTTP2_CANCEL);
		} catch {
			// already closed
		}

		session.close();
	}

	stream.on('response', (headers) => {
		const status = Number(headers[':status'] ?? 0);
		push({ type: 'status', status });
	});

	stream.on('data', (chunk: Buffer) => {
		try {
			for (const frame of decoder.push(chunk)) {
				push({ type: 'frame', frame });
			}
		} catch (error) {
			push({ type: 'error', error: error instanceof Error ? error : new ConnectProtocolError(String(error)) });
			close();
		}
	});

	stream.on('end', () => {
		if (decoder.pendingBytes() > 0) {
			push({ type: 'error', error: new ConnectProtocolError('stream ended mid-frame') });
		} else {
			push({ type: 'closed' });
		}

		close();
	});

	stream.on('error', (error: Error) => {
		push({ type: 'error', error });
		close();
	});

	if (options.signal?.aborted) {
		onAbort();
	}

	return {
		write(message: unknown) {
			if (!stream.closed && !stream.destroyed && stream.writable) {
				stream.write(encodeEnvelope(message));
			}
		},
		end() {
			if (!stream.closed && !stream.destroyed && stream.writable) {
				stream.end();
			}
		},
		close,
		items(): AsyncIterable<BidiStreamItem> {
			return {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<BidiStreamItem>> {
							while (queue.length === 0) {
								if (finished) return { done: true, value: undefined };
								await new Promise<void>((resolve) => {
									notify = resolve;
								});
							}

							const value = queue.shift()!;

							return { done: false, value };
						}
					};
				}
			};
		}
	};
}

export interface UnaryOptions {
	url: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
	timeoutMs: number;
	connect?: Http2Connect;
	/** Response bodies larger than this are rejected. */
	maxResponseBytes?: number;
}

export interface UnaryResult {
	status: number;
	body: unknown;
}

/** Connect unary call with a JSON body over HTTP/2 to an allowlisted Cursor origin. */
export async function connectUnary(options: UnaryOptions): Promise<UnaryResult> {
	const origin = assertCursorOrigin(options.url);
	const connect = options.connect ?? ((authority: string) => http2.connect(authority));
	const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
	const session = connect(origin);

	return await new Promise<UnaryResult>((resolve, reject) => {
		let status = 0;
		let encoding = '';
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;

		const finish = (error: Error | null, result?: UnaryResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			session.close();

			if (error) reject(error);
			else resolve(result!);
		};

		const timer = setTimeout(() => finish(new ConnectProtocolError('deadline_exceeded')), options.timeoutMs);
		session.on('error', (error: Error) => finish(error));

		const stream = session.request({
			...sanitizeRequestHeaders(options.headers),
			':method': 'POST',
			':path': options.path,
			'content-type': 'application/json',
			'connect-protocol-version': '1',
			'connect-timeout-ms': String(options.timeoutMs)
		});

		stream.on('response', (headers) => {
			status = Number(headers[':status'] ?? 0);
			encoding = String(headers['content-encoding'] ?? '');
		});
		stream.on('data', (chunk: Buffer) => {
			size += chunk.length;

			if (size > maxBytes) {
				stream.close(http2.constants.NGHTTP2_CANCEL);
				finish(new ConnectProtocolError('response too large'));

				return;
			}

			chunks.push(chunk);
		});
		stream.on('end', () => {
			try {
				let raw = Buffer.concat(chunks);
				if (encoding === 'gzip') raw = zlib.gunzipSync(raw, { maxOutputLength: maxBytes });
				const text = raw.toString('utf8');
				finish(null, { status, body: text ? (JSON.parse(text) as unknown) : null });
			} catch {
				finish(new ConnectProtocolError('invalid unary response'));
			}
		});
		stream.on('error', (error: Error) => finish(error));
		stream.end(Buffer.from(JSON.stringify(options.body ?? {}), 'utf8'));
	});
}
