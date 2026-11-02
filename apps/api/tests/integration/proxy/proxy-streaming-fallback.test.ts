import { afterEach, describe, expect, it, vi } from 'vitest';

import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import { proxyRequest } from 'src/proxy/anthropic-client';
import { OpenAiClient } from 'src/proxy/openai-client';
import { SsePrecommitGate } from 'src/proxy/sse-precommit-gate';
import { OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';

import type { SubscriptionProvider } from '@ungate/shared';

const SEC = () => Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();

function add(provider: SubscriptionProvider, user: string): OAuthAccountRow {
	return OAuthAccounts.saveLogin(
		provider,
		{ accessToken: `token-${user}`, refreshToken: `refresh-${user}`, expiresAt: Date.now() + 3_600_000 },
		{ providerUserId: user, providerAccountId: provider === 'openai' ? `ws-${user}` : null, email: `${user}@example.com` },
		OAuthAccounts.list(provider)
	);
}

function authOf(init: RequestInit | undefined): string {
	const headers = (init?.headers ?? {}) as Record<string, string>;

	return headers.Authorization ?? headers.authorization ?? '';
}

/** SSE response delivered in the given byte chunks; tracks cancellation. */
function sseResponse(
	chunks: string[],
	headers: Record<string, string> = {},
	options: { hang?: boolean } = {}
): { response: Response; cancelled: () => boolean } {
	let index = 0;
	let wasCancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index++]));

				return undefined;
			}
			if (options.hang) return new Promise<void>(() => undefined);
			controller.close();

			return undefined;
		},
		cancel() {
			wasCancelled = true;
		}
	});

	return {
		response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } }),
		cancelled: () => wasCancelled
	};
}

const anthropicEvent = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const codexEvent = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`;

const claudeStreamBody = {
	model: 'claude-sonnet',
	messages: [{ role: 'user', content: 'hi' }],
	max_tokens: 10,
	stream: true
} as never;
const codexBody = (stream: boolean) => ({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream }) as never;

const claudeSuccess = (text: string) => [
	anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
	anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
	anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
	anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
	anthropicEvent('message_stop', { type: 'message_stop' })
];

const claudeLimitHeaders = (resetSec: number) => ({
	'anthropic-ratelimit-unified-status': 'rejected',
	'anthropic-ratelimit-unified-reset': String(resetSec)
});
const claudeLimitEvent = anthropicEvent('error', {
	type: 'error',
	error: { type: 'rate_limit_error', message: 'Usage limit reached' }
});

async function readAll(stream: ReadableStream | null): Promise<string> {
	if (!stream) return '';
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		out += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
	}

	return out + decoder.decode();
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Claude SSE pre-commit gate', () => {
	it('early SSE usage-limit error before output → rotates to B with no duplicated output', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const reset = SEC() + 1800;
		const limited = sseResponse(
			[
				anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
				claudeLimitEvent
			],
			claudeLimitHeaders(reset),
			{ hang: true }
		);
		const bChunks = claudeSuccess('from-b');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));

				return Promise.resolve(seen.length === 1 ? limited.response : sseResponse(bChunks).response);
			})
		);

		const result = await proxyRequest('/v1/messages', claudeStreamBody, {});
		const body = await readAll(result.response.body);

		expect(seen).toEqual(['Bearer token-a', 'Bearer token-b']);
		expect(limited.cancelled()).toBe(true);
		expect(body).toBe(bChunks.join(''));
		expect(body).not.toContain('Usage limit reached');
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(b.id);
		expect(OAuthAccounts.policy('claude').lastSwitchReason).toBe('anthropic_usage_limit');
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBe(reset * 1000);
		expect(OAuthAccounts.get(a.id)?.cooldownReason).toBe('anthropic_usage_limit');
	});

	it('successful stream replays the inspected bytes exactly, split arbitrarily across chunks', async () => {
		add('claude', 'a');
		const full = claudeSuccess('hello world').join('');
		// Split mid-line and mid-UTF-8-free boundaries to exercise the incremental parser.
		const chunks = [full.slice(0, 7), full.slice(7, 60), full.slice(60, 61), full.slice(61)];
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(sseResponse(chunks).response))
		);

		const result = await proxyRequest('/v1/messages', claudeStreamBody, {});

		expect(result.response.status).toBe(200);
		expect(result.response.headers.get('content-type')).toContain('text/event-stream');
		const body = await readAll(result.response.body);
		expect(body).toBe(full);
	});

	it('unknown early error (overloaded) never rotates; the error bytes are passed through', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		const overloaded = anthropicEvent('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
		const fetchMock = vi.fn(() => Promise.resolve(sseResponse([overloaded]).response));
		vi.stubGlobal('fetch', fetchMock);

		const result = await proxyRequest('/v1/messages', claudeStreamBody, {});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = await readAll(result.response.body);
		expect(body).toBe(overloaded);
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(a.id);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
	});

	it('rate_limit_error without unified rejection headers is throttling, not a usage limit', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		const fetchMock = vi.fn(() => Promise.resolve(sseResponse([claudeLimitEvent]).response));
		vi.stubGlobal('fetch', fetchMock);

		const result = await proxyRequest('/v1/messages', claudeStreamBody, {});
		await readAll(result.response.body);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
	});

	it('mid-stream usage-limit error after output → no retry, client gets an error, cooldown recorded', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		const reset = SEC() + 900;
		const chunks = [...claudeSuccess('partial').slice(0, 3), claudeLimitEvent];
		const fetchMock = vi.fn(() => Promise.resolve(sseResponse(chunks, claudeLimitHeaders(reset)).response));
		vi.stubGlobal('fetch', fetchMock);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const { response, context } = await proxyRequest('/v1/messages', claudeStreamBody, {});
		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'mid', 'claude-sonnet', context);
		const output = await readAll(stream);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(output).toContain('"content":"partial"');
		expect(output).toContain('"type":"rate_limit_error"');
		expect(output).not.toContain('[DONE]');
		expect(output).not.toMatch(/"finish_reason":"/);
		// Later requests switch: A is cooled down but the in-flight request was not replayed.
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBe(reset * 1000);
		expect(OAuthAccounts.get(a.id)?.cooldownReason).toBe('anthropic_usage_limit');
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(a.id);
	});

	it('commits at the time bound without waiting for output', async () => {
		const slow = sseResponse(
			[anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })],
			{},
			{ hang: true }
		);

		const inspected = await SsePrecommitGate.inspect('claude', slow.response, { maxMs: 30 });

		expect(inspected.limit).toBeUndefined();
		const reader = inspected.response.body!.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain('message_start');
		await reader.cancel();
		expect(slow.cancelled()).toBe(true);
	});

	it('commits at the byte bound', async () => {
		const ping = anthropicEvent('ping', { type: 'ping' });
		const many = sseResponse(
			Array.from({ length: 50 }, () => ping),
			{},
			{ hang: true }
		);

		const inspected = await SsePrecommitGate.inspect('claude', many.response, { maxBytes: ping.length * 3 });

		expect(inspected.limit).toBeUndefined();
		await inspected.response.body!.cancel();
		expect(many.cancelled()).toBe(true);
	});

	it('client abort stops fallback immediately: no second attempt, upstream reader cancelled', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		const controller = new AbortController();
		const hanging = sseResponse(
			[anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })],
			{},
			{ hang: true }
		);
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			expect(init?.signal).toBe(controller.signal);
			setTimeout(() => controller.abort(new Error('client gone')), 5);

			return Promise.resolve(hanging.response);
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await proxyRequest('/v1/messages', claudeStreamBody, {}, controller.signal);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.response.status).toBe(499);
		expect(hanging.cancelled()).toBe(true);
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(a.id);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
	});

	it('already-aborted signal never reaches upstream', async () => {
		add('claude', 'a');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const controller = new AbortController();
		controller.abort();

		const result = await proxyRequest('/v1/messages', claudeStreamBody, {}, controller.signal);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.response.status).toBe(499);
	});
});

describe('Codex SSE gate and failure surfacing', () => {
	const codexText = (text: string) => [
		codexEvent({ type: 'response.created', response: { id: 'resp_1' } }),
		codexEvent({ type: 'response.output_text.delta', delta: text }),
		codexEvent({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } })
	];

	it('early response.failed usage_limit_reached → rotates to B (streaming), A cooled with resets_at', async () => {
		const a = add('openai', 'a');
		const b = add('openai', 'b');
		const reset = SEC() + 7200;
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));

				return Promise.resolve(
					seen.length === 1
						? sseResponse([
								codexEvent({ type: 'response.created', response: { id: 'resp_a' } }),
								codexEvent({
									type: 'response.failed',
									response: { error: { code: 'usage_limit_reached', message: 'Usage limit reached', resets_at: reset } }
								})
							]).response
						: sseResponse(codexText('from-b')).response
				);
			})
		);

		const result = await OpenAiClient.proxy(codexBody(true));
		const out = await readAll(result.response.body);

		expect(seen).toEqual(['Bearer token-a', 'Bearer token-b']);
		expect(out).toContain('"content":"from-b"');
		expect(out).not.toContain('Usage limit reached');
		expect(out.match(/\[DONE\]/g)).toHaveLength(1);
		expect(result.context.telemetryDeferred).toBe(true);
		expect(OAuthAccounts.policy('openai').activeAccountId).toBe(b.id);
		expect(OAuthAccounts.policy('openai').lastSwitchReason).toBe('codex_usage_limit_reached');
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBe(reset * 1000);
	});

	it('early error event with resets_in_seconds rotates on the buffered path too', async () => {
		const a = add('openai', 'a');
		add('openai', 'b');
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls++;

				return Promise.resolve(
					calls === 1
						? sseResponse([
								codexEvent({ type: 'error', error: { type: 'usage_limit_reached', message: 'limit', resets_in_seconds: 600 } })
							]).response
						: sseResponse(codexText('ok')).response
				);
			})
		);

		const result = await OpenAiClient.proxy(codexBody(false));
		const json: { choices: { message: { content: string } }[]; usage: unknown } = await result.response.json();

		expect(calls).toBe(2);
		expect(json.choices[0].message.content).toBe('ok');
		expect(json.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
		const until = OAuthAccounts.get(a.id)!.cooldownUntil!;
		expect(until - Date.now()).toBeGreaterThan(590_000);
		expect(until - Date.now()).toBeLessThanOrEqual(600_000);
	});

	it('buffered path: response.failed (non-limit) after output → 502 error, no rotation, no fake success', async () => {
		const a = add('openai', 'a');
		add('openai', 'b');
		const fetchMock = vi.fn(() =>
			Promise.resolve(
				sseResponse([
					codexEvent({ type: 'response.output_text.delta', delta: 'half' }),
					codexEvent({ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } })
				]).response
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await OpenAiClient.proxy(codexBody(false));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.response.status).toBe(502);
		expect(result.context.source).toBe('error');
		const json: unknown = await result.response.json();
		expect(json).toEqual({ error: { message: 'boom', type: 'server_error', code: 'server_error' } });
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
	});

	it('buffered path: stream without a terminal event is an error, not an empty success', async () => {
		add('openai', 'a');
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(sseResponse([codexEvent({ type: 'response.output_text.delta', delta: 'cut' })]).response))
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await OpenAiClient.proxy(codexBody(false));

		expect(result.response.status).toBe(502);
		const json: { error: { code: string } } = await result.response.json();
		expect(json.error.code).toBe('stream_incomplete');
	});

	it('streaming: mid-stream usage limit after output → error event, no [DONE], no retry, cooldown, failure telemetry', async () => {
		const a = add('openai', 'a');
		add('openai', 'b');
		const reset = SEC() + 3000;
		const fetchMock = vi.fn(() =>
			Promise.resolve(
				sseResponse([
					codexEvent({ type: 'response.output_text.delta', delta: 'partial' }),
					codexEvent({ type: 'error', error: { type: 'usage_limit_reached', message: 'limit hit', resets_at: reset } })
				]).response
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await OpenAiClient.proxy(codexBody(true));
		const out = await readAll(result.response.body);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(out).toContain('"content":"partial"');
		expect(out).toContain('"code":"usage_limit_reached"');
		expect(out).not.toContain('[DONE]');
		expect(out).not.toContain('"finish_reason":"stop"');
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBe(reset * 1000);
		expect(OAuthAccounts.get(a.id)?.cooldownReason).toBe('codex_usage_limit_reached');
		expect(OAuthAccounts.policy('openai').activeAccountId).toBe(a.id);
	});

	it('streaming: downstream cancel cancels the upstream reader', async () => {
		add('openai', 'a');
		const upstream = sseResponse([codexEvent({ type: 'response.output_text.delta', delta: 'x' })], {}, { hang: true });
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(upstream.response))
		);

		const result = await OpenAiClient.proxy(codexBody(true));
		const reader = result.response.body!.getReader();
		await reader.read();
		await reader.cancel('client gone');

		expect(upstream.cancelled()).toBe(true);
	});
});
