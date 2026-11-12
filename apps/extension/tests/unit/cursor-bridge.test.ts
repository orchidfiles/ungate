import { EventEmitter } from 'node:events';
import * as zlib from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
	assertCursorOrigin,
	CONNECT_FLAG_COMPRESSED,
	CONNECT_FLAG_END_STREAM,
	ConnectFrameDecoder,
	ConnectProtocolError,
	encodeEnvelope,
	isTransientDnsError,
	openBidiStream,
	type Http2Connect
} from '../../src/cursor/connect-transport';
import { CursorBridge, type BridgeChild } from '../../src/cursor/cursor-bridge';
import { CursorSession } from '../../src/cursor/cursor-session';
import { PacerAbortError, PacerTimeoutError, RequestPacer } from '../../src/cursor/request-pacer';
import {
	classifyInvocationError,
	describeToolCallShape,
	mapStreamResponse,
	redactMessage,
	runInference
} from '../../src/cursor/run-inference';

import type { CursorBridgeEventBody } from '@ungate/shared';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMzQ1Njc4OTAifQ.c2lnbmF0dXJlLXNlY3JldA';

function envelope(message: unknown, flags = 0): Buffer {
	return encodeEnvelope(message, flags);
}

describe('Connect framing', () => {
	it('decodes frames split across arbitrary chunk boundaries', () => {
		const bytes = Buffer.concat([envelope({ a: 1 }), envelope({ b: 2 }), envelope({}, CONNECT_FLAG_END_STREAM)]);
		const decoder = new ConnectFrameDecoder();
		const frames = [];
		for (let i = 0; i < bytes.length; i += 3) frames.push(...decoder.push(bytes.subarray(i, i + 3)));
		expect(frames.map((frame) => frame.message)).toEqual([{ a: 1 }, { b: 2 }, {}]);
		expect(frames[2].flags & CONNECT_FLAG_END_STREAM).toBeTruthy();
		expect(decoder.pendingBytes()).toBe(0);
	});

	it('gunzips compressed frames', () => {
		const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ hello: 'world' })));
		const header = Buffer.alloc(5);
		header.writeUInt8(CONNECT_FLAG_COMPRESSED, 0);
		header.writeUInt32BE(payload.length, 1);
		expect(new ConnectFrameDecoder().push(Buffer.concat([header, payload]))[0].message).toEqual({ hello: 'world' });
	});

	it('reports truncated frames and invalid JSON', () => {
		const decoder = new ConnectFrameDecoder();
		decoder.push(envelope({ a: 1 }).subarray(0, 7));
		expect(decoder.pendingBytes()).toBeGreaterThan(0);
		const bad = Buffer.concat([Buffer.from([0, 0, 0, 0, 3]), Buffer.from('{x}')]);
		expect(() => new ConnectFrameDecoder().push(bad)).toThrow(ConnectProtocolError);
	});

	it('only allows https cursor.sh origins', () => {
		expect(assertCursorOrigin('https://agentn.api5.cursor.sh/x')).toBe('https://agentn.api5.cursor.sh');
		for (const url of [
			'http://api2.cursor.sh',
			'https://cursor.sh.evil.com',
			'https://evilcursor.sh',
			'https://u:p@api2.cursor.sh',
			'nope'
		]) {
			expect(() => assertCursorOrigin(url)).toThrow();
		}
		expect(() => openBidiStream({ url: 'https://example.com', path: '/', headers: {}, deadlineMs: 1000 })).toThrow();
	});
});

/** Fake Cursor RunInference server: answers each client frame with scripted frames. */
function fakeCursor(script: (message: Record<string, unknown>, reply: (frame: Buffer) => void, end: () => void) => void) {
	const written: Record<string, unknown>[] = [];
	const requestHeaders: Record<string, string>[] = [];
	const connect: Http2Connect = () => {
		const session = new EventEmitter() as EventEmitter & { request: unknown; close: () => void };
		session.close = () => undefined;
		session.request = (headers: Record<string, string>) => {
			requestHeaders.push(headers);
			const stream = Object.assign(new EventEmitter(), { closed: false, destroyed: false, writable: true }) as EventEmitter & {
				closed: boolean;
				destroyed: boolean;
				writable: boolean;
				write: (chunk: Buffer) => void;
				end: () => void;
				close: () => void;
			};
			const decoder = new ConnectFrameDecoder();
			const reply = (frame: Buffer) => setImmediate(() => stream.emit('data', frame));
			const end = () => setImmediate(() => stream.emit('end'));
			stream.write = (chunk) => {
				for (const frame of decoder.push(chunk)) {
					const message = frame.message as Record<string, unknown>;
					written.push(message);
					script(message, reply, end);
				}
			};
			stream.end = () => {
				stream.writable = false;
			};
			stream.close = () => {
				stream.closed = true;
			};
			setImmediate(() => stream.emit('response', { ':status': 200 }));

			return stream;
		};

		return session as never;
	};

	return { connect, written, requestHeaders };
}

const creds = () => ({
	headers: { authorization: `Bearer ${TOKEN}`, 'x-cursor-checksum': 'abc' },
	backendUrl: 'https://api2.cursor.sh',
	agentUrl: 'https://agentn.api5.cursor.sh'
});
const request = {
	modelId: 'grok-4.7-low-fast',
	messages: [{ role: 'INFERENCE_MESSAGE_ROLE_USER' as const, text: 'hi' }],
	tools: []
};

async function collect(events: AsyncIterable<CursorBridgeEventBody>): Promise<CursorBridgeEventBody[]> {
	const out: CursorBridgeEventBody[] = [];
	for await (const event of events) out.push(event);

	return out;
}

describe('tool call argument shapes', () => {
	const state = () => ({ sawExtendedUsage: false });
	const toolCall = (part: Record<string, unknown>) =>
		mapStreamResponse({ toolCallPart: { toolCallId: 'c1', toolName: 'Read', isComplete: true, ...part } }, state());

	it('keeps string args', () => {
		expect(toolCall({ args: '{"path":"a"}' })).toMatchObject({ kind: 'toolCall', args: '{"path":"a"}' });
	});

	it('serializes object args instead of dropping them', () => {
		expect(toolCall({ args: { path: 'a' } })).toMatchObject({ kind: 'toolCall', args: '{"path":"a"}' });
	});

	it('reads alternate argument fields', () => {
		expect(toolCall({ argsDelta: '{"path":"b"}' })).toMatchObject({ args: '{"path":"b"}' });
		expect(toolCall({ arguments: { path: 'c' } })).toMatchObject({ args: '{"path":"c"}' });
	});

	it('describes field shapes without values', () => {
		const shape = describeToolCallShape({ toolName: 'Read', args: 'secret', isComplete: true, extra: null });
		expect(shape).toBe('toolName:string(4), args:string(6), isComplete:boolean, extra:null');
		expect(shape).not.toContain('secret');
	});
});

describe('runInference state machine', () => {
	it('runs runRequest -> runReady -> invokeModel -> responses -> invocationEnd -> finishRun', async () => {
		const server = fakeCursor((message, reply, end) => {
			if (message.runRequest)
				reply(envelope({ runReady: { resolvedModel: { modelId: 'grok-4.7-low-fast' }, configFingerprint: 'fp1' } }));
			if (message.invokeModel) {
				reply(envelope({ invocationResponse: { response: { textPart: { text: 'Hello' } } } }));
				reply(envelope({ invocationResponse: { response: { extendedUsage: { inputTokens: 5, outputTokens: 2 } } } }));
				reply(envelope({ invocationEnd: {} }));
			}
			if (message.finishRun) {
				reply(envelope({}, CONNECT_FLAG_END_STREAM));
				end();
			}
		});
		const events = await collect(
			runInference({ request, credentials: creds, refresh: () => Promise.resolve(), connect: server.connect })
		);

		expect(events.map((event) => event.kind)).toEqual(['ready', 'text', 'usage', 'end']);
		expect(events.at(-1)).toEqual({ kind: 'end', error: null });
		const invoke = server.written.find((message) => message.invokeModel)?.invokeModel as Record<string, unknown>;
		expect(invoke.configFingerprint).toBe('fp1');
		const invokeRequest = invoke.request as Record<string, unknown>;
		expect(invokeRequest).not.toHaveProperty('requestedModel');
		expect(invokeRequest).not.toHaveProperty('conversationId');
		expect(invokeRequest).not.toHaveProperty('invocationId');
		expect(server.written.at(-1)).toEqual({ finishRun: { aborted: false, turnCompleted: true } });
		expect(server.requestHeaders[0]['content-type']).toBe('application/connect+json');
	});

	it('sends cancelInvocation + finishRun{aborted} when cancelled after output', async () => {
		const controller = new AbortController();
		const server = fakeCursor((message, reply) => {
			if (message.runRequest) reply(envelope({ runReady: {} }));
			if (message.invokeModel) reply(envelope({ invocationResponse: { response: { textPart: { text: 'partial' } } } }));
		});
		const events: CursorBridgeEventBody[] = [];
		for await (const event of runInference({
			request,
			credentials: creds,
			refresh: () => Promise.resolve(),
			signal: controller.signal,
			connect: server.connect
		})) {
			events.push(event);
			if (event.kind === 'text') controller.abort();
		}

		expect(events.at(-1)).toMatchObject({ kind: 'end', error: { kind: 'cancelled' } });
		const kinds = server.written.map((message) => Object.keys(message)[0]);
		expect(kinds).toContain('cancelInvocation');
		expect(server.written.at(-1)).toEqual({ finishRun: { aborted: true, turnCompleted: false } });
	});

	it('refreshes once and retries on auth failure before output', async () => {
		let attempts = 0;
		const refresh = vi.fn(() => Promise.resolve());
		const server = fakeCursor((message, reply, end) => {
			if (!message.runRequest) return;
			attempts += 1;
			if (attempts === 1) {
				reply(envelope({ error: { code: 'unauthenticated', message: 'ERROR_NOT_LOGGED_IN' } }, CONNECT_FLAG_END_STREAM));
				end();

				return;
			}
			reply(envelope({ runReady: {} }));
			reply(envelope({ invocationEnd: {} }));
		});
		const events = await collect(runInference({ request, credentials: creds, refresh, connect: server.connect }));
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(attempts).toBe(2);
		expect(events.filter((event) => event.kind === 'end')).toEqual([{ kind: 'end', error: null }]);
	});

	it('classifies Grok 422 tool schema rejections and redacts tokens', () => {
		expect(classifyInvocationError({ code: 8, message: 'provider returned 422 for tool parameters' }).kind).toBe('tool_schema');
		expect(classifyInvocationError({ code: 5, message: 'ERROR_BAD_MODEL_NAME' }).kind).toBe('bad_model');
		expect(classifyInvocationError({ code: 16, message: 'ERROR_NOT_LOGGED_IN' }).kind).toBe('auth');
		expect(redactMessage(`failed with Bearer ${TOKEN} and ${TOKEN}`)).not.toContain(TOKEN);
	});
});

function fakeChild() {
	const sent: unknown[] = [];
	const emitter = new EventEmitter();
	const child = Object.assign(emitter, {
		connected: true,
		send: (message: unknown) => {
			sent.push(message);

			return true;
		}
	}) as unknown as BridgeChild & EventEmitter;

	return { child, sent };
}

function session(signedIn = true) {
	return new CursorSession({
		getCursorAuthToken: () => (signedIn ? TOKEN : null),
		getAllRequestHeadersExceptAccessToken: ({ req }: { req: { header: Headers } }) =>
			req.header.set('x-cursor-checksum', 'checksum-secret'),
		getCursorCreds: () => ({ backendUrl: 'https://api2.cursor.sh' }),
		membershipType: () => 'ultra'
	});
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('CursorBridge', () => {
	it('reports no_bridge until attached', () => {
		const bridge = new CursorBridge({ session: session(), isEnabled: () => true });
		expect(bridge.status()).toMatchObject({ available: false, reason: 'no_bridge' });
	});

	it('rejects invocations while disabled or signed out', async () => {
		let enabled = false;
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({ session: session(), isEnabled: () => enabled });
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'r1', request });
		await tick();
		expect(sent).toEqual([
			{ channel: 'ungate.cursor-bridge', id: 'r1', kind: 'end', error: expect.objectContaining({ kind: 'disabled' }) }
		]);

		enabled = true;
		const signedOut = new CursorBridge({ session: session(false), isEnabled: () => enabled });
		const other = fakeChild();
		signedOut.attach(other.child);
		signedOut.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'r2', request });
		await tick();
		expect(other.sent[0]).toMatchObject({ kind: 'end', error: { kind: 'auth' } });
	});

	it('re-reads a token Cursor cached as missing before reporting not_signed_in', async () => {
		let token: string | undefined;
		const refresh = vi.fn(() => {
			token = TOKEN;
		});
		const recovering = new CursorSession({
			getCursorAuthToken: () => token,
			getAllRequestHeadersExceptAccessToken: () => undefined,
			triggerRefreshCursorAuthToken: refresh,
			membershipType: () => 'ultra'
		});
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({ session: recovering, isEnabled: () => true });
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'status', id: 's1' });
		await tick();
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(sent[0]).toMatchObject({ kind: 'status', status: { connected: true, reason: 'ok' } });
	});

	it('streams events back without ever sending credentials, and cancels on child exit', async () => {
		const server = fakeCursor((message, reply) => {
			if (message.runRequest) reply(envelope({ runReady: {} }));
			if (message.invokeModel) reply(envelope({ invocationResponse: { response: { textPart: { text: 'hi' } } } }));
		});
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({ session: session(), isEnabled: () => true, connect: server.connect });
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'status', id: 's1' });
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'r1', request });
		await tick();
		expect(sent[0]).toMatchObject({ kind: 'status', status: { connected: true, membershipType: 'ultra' } });
		expect(sent.map((message) => (message as { kind: string }).kind)).toEqual(['status', 'ready', 'text']);

		child.emit('exit');
		await tick();
		expect(bridge.isAttached()).toBe(false);
		expect(server.written.at(-1)).toEqual({ finishRun: { aborted: true, turnCompleted: false } });

		const serialized = JSON.stringify(sent);
		expect(serialized).not.toContain(TOKEN);
		expect(serialized).not.toContain('checksum-secret');
		expect(serialized).not.toMatch(/authorization|bearer/i);
		// The upstream request does carry them (extension host only).
		expect(server.requestHeaders[0].authorization).toBe(`Bearer ${TOKEN}`);
	});
});

/** First `failures` sessions fail with `error` before responding; later ones run `server`. */
function flakyConnect(server: Http2Connect, error: () => Error, failures = 1) {
	let calls = 0;
	const connect: Http2Connect = (authority) => {
		calls += 1;
		if (calls > failures) return server(authority);
		const session = new EventEmitter() as EventEmitter & { request: unknown; close: () => void };
		session.close = () => undefined;
		session.request = () => {
			const stream = Object.assign(new EventEmitter(), {
				closed: false,
				destroyed: false,
				writable: true,
				write: () => undefined,
				end: () => undefined,
				close: () => undefined
			});
			setImmediate(() => session.emit('error', error()));

			return stream;
		};

		return session as never;
	};

	return { connect, calls: () => calls };
}

const dnsError = () => Object.assign(new Error('getaddrinfo EAI_AGAIN agentn.api5.cursor.sh'), { code: 'EAI_AGAIN' });

describe('transient DNS retry', () => {
	const happy = () =>
		fakeCursor((message, reply) => {
			if (message.runRequest) reply(envelope({ runReady: {} }));
			if (message.invokeModel) {
				reply(envelope({ invocationResponse: { response: { textPart: { text: 'ok' } } } }));
				reply(envelope({ invocationEnd: {} }));
			}
		});

	it('replays the run on a fresh session after one EAI_AGAIN before any response', async () => {
		const server = happy();
		const flaky = flakyConnect(server.connect, dnsError);
		const events = await collect(
			runInference({ request, credentials: creds, refresh: () => Promise.resolve(), connect: flaky.connect })
		);
		expect(flaky.calls()).toBe(2);
		expect(server.written[0]).toHaveProperty('runRequest');
		expect(events.map((event) => event.kind)).toEqual(['ready', 'text', 'end']);
		expect(events.at(-1)).toEqual({ kind: 'end', error: null });
	});

	it('retries only once', async () => {
		const server = happy();
		const flaky = flakyConnect(server.connect, dnsError, 2);
		const events = await collect(
			runInference({ request, credentials: creds, refresh: () => Promise.resolve(), connect: flaky.connect })
		);
		expect(flaky.calls()).toBe(2);
		expect(events).toEqual([
			{ kind: 'end', error: expect.objectContaining({ kind: 'upstream', message: expect.stringContaining('EAI_AGAIN') }) }
		]);
	});

	it('does not retry non-DNS session errors', async () => {
		const server = happy();
		const flaky = flakyConnect(server.connect, () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
		const events = await collect(
			runInference({ request, credentials: creds, refresh: () => Promise.resolve(), connect: flaky.connect })
		);
		expect(flaky.calls()).toBe(1);
		expect(events.at(-1)).toMatchObject({ kind: 'end', error: { kind: 'upstream' } });
	});

	it('recognizes DNS codes and messages', () => {
		expect(isTransientDnsError({ code: 'ENOTFOUND' })).toBe(true);
		expect(isTransientDnsError(new Error('getaddrinfo EAI_AGAIN host'))).toBe(true);
		expect(isTransientDnsError({ code: 'ECONNRESET' })).toBe(false);
		expect(isTransientDnsError(null)).toBe(false);
	});
});

describe('RequestPacer', () => {
	it('caps concurrency per key, spaces starts and keeps FIFO order', async () => {
		vi.useFakeTimers();
		try {
			const pacer = new RequestPacer({ maxConcurrent: 1, minIntervalMs: 1_000, maxWaitMs: 60_000 });
			const order: string[] = [];
			const a = pacer.acquire('grok').then((release) => (order.push('a'), release));
			const b = pacer.acquire('grok').then((release) => (order.push('b'), release));
			const other = pacer.acquire('composer').then((release) => (order.push('other'), release));

			await vi.advanceTimersByTimeAsync(0);
			expect(order).toEqual(['a', 'other']);
			expect(pacer.snapshot('grok')).toEqual({ active: 1, queued: 1 });

			const releaseA = await a;
			releaseA();
			await vi.advanceTimersByTimeAsync(500);
			expect(order).toEqual(['a', 'other']);
			await vi.advanceTimersByTimeAsync(500);
			expect(order).toEqual(['a', 'other', 'b']);
			const releaseB = await b;
			releaseB();
			const releaseOther = await other;
			releaseOther();
		} finally {
			vi.useRealTimers();
		}
	});

	it('delays starts after penalize and times out queued waiters', async () => {
		vi.useFakeTimers();
		try {
			const pacer = new RequestPacer({ maxConcurrent: 1, minIntervalMs: 0, maxWaitMs: 3_000 });
			pacer.penalize('grok', 2_000);
			let started = false;
			const first = pacer.acquire('grok').then((release) => ((started = true), release));
			await vi.advanceTimersByTimeAsync(1_999);
			expect(started).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(started).toBe(true);

			const blocked = pacer.acquire('grok').catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(3_000);
			const blockedError = await blocked;
			expect(blockedError).toBeInstanceOf(PacerTimeoutError);
			const releaseFirst = await first;
			releaseFirst();
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects aborted waiters without granting them a slot', async () => {
		const pacer = new RequestPacer({ maxConcurrent: 1, minIntervalMs: 0, maxWaitMs: 60_000 });
		const release = await pacer.acquire('grok');
		const controller = new AbortController();
		const waiting = pacer.acquire('grok', controller.signal);
		controller.abort();
		await expect(waiting).rejects.toBeInstanceOf(PacerAbortError);
		release();
		expect(pacer.snapshot('grok')).toEqual({ active: 0, queued: 0 });
	});
});

describe('CursorBridge pacing', () => {
	const rateLimited = (failures: number) => {
		let runs = 0;
		const server = fakeCursor((message, reply, end) => {
			if (message.runRequest) {
				runs += 1;
				if (runs <= failures) {
					reply(envelope({ error: { code: 'resource_exhausted', message: 'rate limited' } }, CONNECT_FLAG_END_STREAM));
					end();

					return;
				}
				reply(envelope({ runReady: { resolvedModel: { modelId: 'grok-4.7' } } }));
			}
			if (message.invokeModel) {
				reply(envelope({ invocationResponse: { response: { textPart: { text: 'hi' } } } }));
				reply(envelope({ invocationEnd: {} }));
			}
		});

		return { server, runs: () => runs };
	};

	const fastPacer = () => new RequestPacer({ maxConcurrent: 2, minIntervalMs: 0, maxWaitMs: 60_000 });

	it('retries a run rate-limited before output and forwards a single clean stream', async () => {
		const upstream = rateLimited(1);
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({
			session: session(),
			isEnabled: () => true,
			connect: upstream.server.connect,
			pacer: fastPacer(),
			retryDelaysMs: [5, 5]
		});
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'r1', request });
		await tick();
		await tick();

		expect(upstream.runs()).toBe(2);
		expect(sent.map((message) => (message as { kind: string }).kind)).toEqual(['ready', 'text', 'end']);
		expect(sent.at(-1)).toMatchObject({ kind: 'end', error: null });
	});

	it('gives up with rate_limit after the retry budget', async () => {
		const upstream = rateLimited(99);
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({
			session: session(),
			isEnabled: () => true,
			connect: upstream.server.connect,
			pacer: fastPacer(),
			retryDelaysMs: [5, 5]
		});
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'r1', request });
		await tick();
		await tick();

		expect(upstream.runs()).toBe(3);
		expect(sent).toEqual([expect.objectContaining({ kind: 'end', error: expect.objectContaining({ kind: 'rate_limit' }) })]);
	});

	it('queues concurrent invocations for one model behind the pacer', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const server = fakeCursor((message, reply) => {
			if (message.runRequest) reply(envelope({ runReady: {} }));
			if (message.invokeModel)
				void gate.then(() => {
					reply(envelope({ invocationResponse: { response: { textPart: { text: 'x' } } } }));
					reply(envelope({ invocationEnd: {} }));
				});
		});
		const pacer = new RequestPacer({ maxConcurrent: 1, minIntervalMs: 0, maxWaitMs: 60_000 });
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({ session: session(), isEnabled: () => true, connect: server.connect, pacer });
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'a', request });
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'b', request });
		await tick();

		expect(pacer.snapshot(request.modelId)).toEqual({ active: 1, queued: 1 });
		expect(sent.every((message) => (message as { id: string }).id === 'a')).toBe(true);

		release();
		await tick();
		await tick();
		const ends = sent.filter((message) => (message as { kind: string }).kind === 'end');
		expect(ends.map((message) => (message as { id: string }).id)).toEqual(['a', 'b']);
	});
});
