import { EventEmitter } from 'node:events';
import * as zlib from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
	assertCursorOrigin,
	CONNECT_FLAG_COMPRESSED,
	ConnectFrameDecoder,
	ConnectProtocolError,
	encodeEnvelope,
	isTransientDnsError,
	openBidiStream
} from '../../src/cursor/connect-transport';
import { CursorBridge, type BridgeChild } from '../../src/cursor/cursor-bridge';
import { CursorSession } from '../../src/cursor/cursor-session';
import { PacerAbortError, PacerTimeoutError, RequestPacer } from '../../src/cursor/request-pacer';
import {
	buildRunRequest,
	buildStreamRequest,
	classifyInvocationError,
	describeToolCallShape,
	mapStreamResponse,
	redactMessage,
	runInference
} from '../../src/cursor/run-inference';

import type { CursorBridgeEventBody } from '@ungate/shared';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMzQ1Njc4OTAifQ.c2lnbmF0dXJlLXNlY3JldA';
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

function fakeChild() {
	const sent: unknown[] = [];
	const child = Object.assign(new EventEmitter(), {
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
		getAllRequestHeadersExceptAccessToken: () => undefined,
		getCursorCreds: () => ({ backendUrl: 'https://api2.cursor.sh' }),
		membershipType: () => 'ultra'
	});
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Cursor inference billing policy', () => {
	it.each(['grok-4.7-low-fast', 'composer-2', 'claude-opus', 'gpt-5', 'unknown-model'])(
		'blocks direct inference for %s before credentials, refresh or connection',
		async (modelId) => {
			const credentials = vi.fn(() => {
				throw new Error('must not read credentials');
			});
			const refresh = vi.fn(() => {
				throw new Error('must not refresh');
			});
			const connect = vi.fn(() => {
				throw new Error('must not connect or write');
			});
			const events = await collect(runInference({ request: { ...request, modelId }, credentials, refresh, connect }));
			expect(events).toEqual([
				{
					kind: 'end',
					error: {
						kind: 'billing_blocked',
						code: 'billing_blocked',
						message: 'Cursor inference is blocked because subscription-only billing cannot be guaranteed.'
					}
				}
			]);
			expect(credentials).not.toHaveBeenCalled();
			expect(refresh).not.toHaveBeenCalled();
			expect(connect).not.toHaveBeenCalled();
		}
	);

	it.each([false, true])('blocks IPC invocation even with persisted enabled=%s', async (enabled) => {
		const current = session();
		const credentials = vi.spyOn(current, 'credentials');
		const recover = vi.spyOn(current, 'ensureSignedIn');
		const refresh = vi.spyOn(current, 'refresh');
		const connect = vi.fn(() => {
			throw new Error('must not connect');
		});
		const pacer = new RequestPacer({ maxConcurrent: 1, minIntervalMs: 0, maxWaitMs: 50 });
		const acquire = vi.spyOn(pacer, 'acquire');
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({ session: current, isEnabled: () => enabled, connect, pacer, retryDelaysMs: [0, 0] });
		bridge.attach(child);
		for (const id of ['first', 'second']) bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id, request });
		await tick();
		expect(sent).toHaveLength(2);
		for (const event of sent)
			expect(event).toMatchObject({ kind: 'end', error: { kind: 'billing_blocked', code: 'billing_blocked' } });
		expect(credentials).not.toHaveBeenCalled();
		expect(recover).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
		expect(JSON.stringify(sent)).not.toContain(TOKEN);
		child.emit('exit');
		expect(bridge.isAttached()).toBe(false);
	});

	it('uses the billing error even when signed out or the request is malformed', async () => {
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({ session: session(false), isEnabled: () => true });
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'invoke', id: 'bad', request: null });
		await tick();
		expect(sent).toEqual([expect.objectContaining({ kind: 'end', error: expect.objectContaining({ kind: 'billing_blocked' }) })]);
	});
});

describe('Cursor session discovery remains available', () => {
	it('reports no_bridge until attached', () => {
		expect(new CursorBridge({ session: session(), isEnabled: () => true }).status()).toMatchObject({ reason: 'no_bridge' });
	});

	it('can recover authentication for status without invoking a model', async () => {
		let token: string | undefined;
		const refresh = vi.fn(() => {
			token = TOKEN;
		});
		const current = new CursorSession({
			getCursorAuthToken: () => token,
			getAllRequestHeadersExceptAccessToken: () => undefined,
			triggerRefreshCursorAuthToken: refresh,
			membershipType: () => 'ultra'
		});
		const { child, sent } = fakeChild();
		const bridge = new CursorBridge({ session: current, isEnabled: () => true });
		bridge.attach(child);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'status', id: 'status' });
		await tick();
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(sent[0]).toMatchObject({ kind: 'status', status: { connected: true, reason: 'ok' } });
	});
});

describe('Connect framing (transport only)', () => {
	it('decodes split frames and compressed envelopes', () => {
		const decoder = new ConnectFrameDecoder();
		const bytes = encodeEnvelope({ a: 1 });
		const frames = [];
		for (let i = 0; i < bytes.length; i += 3) frames.push(...decoder.push(bytes.subarray(i, i + 3)));
		expect(frames.map((frame) => frame.message)).toEqual([{ a: 1 }]);
		const payload = zlib.gzipSync(Buffer.from('{"hello":"world"}'));
		const header = Buffer.alloc(5);
		header.writeUInt8(CONNECT_FLAG_COMPRESSED, 0);
		header.writeUInt32BE(payload.length, 1);
		expect(decoder.push(Buffer.concat([header, payload]))[0].message).toEqual({ hello: 'world' });
	});
	it('rejects invalid JSON and non-Cursor origins', () => {
		expect(() => new ConnectFrameDecoder().push(Buffer.concat([Buffer.from([0, 0, 0, 0, 3]), Buffer.from('{x}')]))).toThrow(
			ConnectProtocolError
		);
		expect(assertCursorOrigin('https://agentn.api5.cursor.sh/x')).toBe('https://agentn.api5.cursor.sh');
		for (const url of [
			'http://api2.cursor.sh',
			'https://cursor.sh.evil.com',
			'https://evilcursor.sh',
			'https://u:p@api2.cursor.sh',
			'nope'
		])
			expect(() => assertCursorOrigin(url)).toThrow();
		expect(() => openBidiStream({ url: 'https://example.com', path: '/', headers: {}, deadlineMs: 1000 })).toThrow();
	});
	it('recognizes DNS errors', () => {
		expect(isTransientDnsError({ code: 'ENOTFOUND' })).toBe(true);
		expect(isTransientDnsError(new Error('getaddrinfo EAI_AGAIN host'))).toBe(true);
		expect(isTransientDnsError({ code: 'ECONNRESET' })).toBe(false);
	});
});

// Static evidence: Cursor 3.29.9 cursor-agent-host/dist/main.js selects a
// separate backend/localLoopInference transport for RunInference. The override
// requires !HTTP2-disabled and URL !== localLoopInferenceFellBackUrl. Those
// conditions are not exposed by our session API; a configured URL is insufficient.
describe('offline native inference routing and request shape', () => {
	it.each([false, true])('keeps inference on the trusted backend with privacy=%s', (privacyMode) => {
		const current = new CursorSession({
			getCursorAuthToken: () => TOKEN,
			getAllRequestHeadersExceptAccessToken: () => undefined,
			getPrivacyMode: () => privacyMode,
			getCursorCreds: () => ({
				backendUrl: 'https://api2.cursor.sh',
				agentBackendUrlPrivacy: { default: 'https://privacy.cursor.sh' },
				agentBackendUrlNonPrivacy: { default: 'https://agentn.api5.cursor.sh' },
				localLoopInferenceUrl: 'https://loop.cursor.sh'
			})
		});
		const creds = current.credentials('request-id');
		expect(creds?.inferenceUrl).toBe('https://api2.cursor.sh');
		expect(creds?.inferenceUrl).not.toBe(creds?.agentUrl);
		expect(creds?.headers['x-request-id']).toBe('request-id');
	});

	it.each(['https://evil.example', 'http://api2.cursor.sh', 'https://user:pass@api2.cursor.sh'])(
		'rejects untrusted inference backend %s',
		(backendUrl) => {
			const current = new CursorSession({
				getCursorAuthToken: () => TOKEN,
				getAllRequestHeadersExceptAccessToken: () => undefined,
				getPrivacyMode: () => true,
				getCursorCreds: () => ({ backendUrl, localLoopInferenceUrl: backendUrl })
			});
			expect(current.credentials()?.inferenceUrl).toBe('https://api2.cursor.sh');
		}
	);

	it('omits unsupported built-in claims and invented previous linkage for unknown models', () => {
		const input = { ...request, modelId: 'unknown-model' };
		const result = buildRunRequest(input, 'fallback-id');
		expect(result).toMatchObject({ runRequest: { conversationId: 'fallback-id', requestedModel: { modelId: 'unknown-model' } } });
		expect(result.runRequest).not.toHaveProperty('previousRequestId');
		expect(result.runRequest).not.toHaveProperty('requestedModel.builtInModel');
		expect(buildRunRequest(input, 'fallback-id')).toEqual(result);
	});

	// 3.29.9 dist/900.js: runRequest forwards previousRequestId:e.previousRequestId.
	it.each([true, false])('preserves supplied model metadata (%s) and genuine linkage only on runRequest', (builtInModel) => {
		const input = { ...request, builtInModel, conversationId: 'conversation', previousRequestId: 'previous' };
		expect(buildRunRequest(input, 'unused')).toMatchObject({
			runRequest: { conversationId: 'conversation', previousRequestId: 'previous', requestedModel: { builtInModel } }
		});
		expect(buildStreamRequest(input)).toEqual({ messages: input.messages, tools: input.tools });
		expect(buildStreamRequest({ ...input, modelConfig: { temperature: 0.5 } })).toEqual({
			messages: input.messages,
			tools: input.tools,
			modelConfig: { temperature: 0.5 }
		});
	});
});

describe('pure response helpers', () => {
	it('preserves alternate tool argument shapes and redacts credentials', () => {
		for (const part of [{ args: '{"path":"a"}' }, { args: { path: 'a' } }, { arguments: { path: 'a' } }]) {
			expect(mapStreamResponse({ toolCallPart: { toolName: 'Read', ...part } }, { sawExtendedUsage: false })).toMatchObject({
				args: '{"path":"a"}'
			});
		}
		expect(describeToolCallShape({ args: 'secret' })).toBe('args:string(6)');
		expect(classifyInvocationError({ code: 8, message: 'provider returned 422 for tool parameters' }).kind).toBe('tool_schema');
		expect(redactMessage(`Bearer ${TOKEN}`)).not.toContain(TOKEN);
	});
});

describe('RequestPacer (independent of inference)', () => {
	it('queues a lane and releases it in order', async () => {
		const pacer = new RequestPacer({ maxConcurrent: 1, minIntervalMs: 0, maxWaitMs: 100 });
		const release = await pacer.acquire('model');
		let granted = false;
		const pending = pacer.acquire('model').then((next) => {
			granted = true;

			return next;
		});
		await Promise.resolve();
		expect(granted).toBe(false);
		release();
		const releaseNext = await pending;
		releaseNext();
	});
	it('rejects aborted and timed-out waiters', async () => {
		const pacer = new RequestPacer({ maxConcurrent: 1, minIntervalMs: 0, maxWaitMs: 10 });
		const release = await pacer.acquire('model');
		const controller = new AbortController();
		const pending = pacer.acquire('model', controller.signal);
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(PacerAbortError);
		await expect(pacer.acquire('model')).rejects.toBeInstanceOf(PacerTimeoutError);
		release();
	});
});
