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
	openBidiStream,
	type Http2Connect
} from '../../src/cursor/connect-transport';
import { CursorBridge, type BridgeChild } from '../../src/cursor/cursor-bridge';
import { CursorSession } from '../../src/cursor/cursor-session';
import { classifyInvocationError, redactMessage, runInference } from '../../src/cursor/run-inference';

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
