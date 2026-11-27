import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import { UPSTREAM_RETRY } from 'src/proxy/account-fallback';
import { proxyRequest } from 'src/proxy/anthropic-client';
import { OpenAiClient } from 'src/proxy/openai-client';

import type { SubscriptionProvider } from '@ungate/shared';

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

const anthropicEvent = (name: string, data: Record<string, unknown>) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const sse = (chunks: string[]) =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);

const claudeSuccess = sse([
	anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
	anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
	anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
	anthropicEvent('message_stop', { type: 'message_stop' })
]);

const claudeStreamBody = {
	model: 'claude-sonnet',
	messages: [{ role: 'user', content: 'hi' }],
	max_tokens: 10,
	stream: true
} as never;
const claudeBody = { model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } as never;
const openAiBody = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: false } as never;

const saved = { ...UPSTREAM_RETRY };

beforeEach(() => {
	UPSTREAM_RETRY.baseDelayMs = 1;
});

afterEach(() => {
	Object.assign(UPSTREAM_RETRY, saved);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('pre-commit upstream retry', () => {
	it('Claude 529 then 200 on the same account: served, no cooldown, no switch', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));

				return Promise.resolve(
					seen.length === 1
						? new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 })
						: new Response('{"usage":{"input_tokens":1}}', { status: 200 })
				);
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer token-a', 'Bearer token-a']);
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(a.id);
		expect(OAuthAccounts.get(a.id)!.cooldownUntil).toBeNull();
	});

	it('repeated 503 on one account moves to the next account without cooling the first down', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));

				return Promise.resolve(
					authOf(init) === 'Bearer token-a'
						? new Response('unavailable', { status: 503 })
						: new Response('{"usage":{"input_tokens":1}}', { status: 200 })
				);
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer token-a', 'Bearer token-a', 'Bearer token-b']);
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(b.id);
		expect(OAuthAccounts.policy('claude').lastSwitchReason).toBe('upstream_transient');
		expect(OAuthAccounts.get(a.id)!.cooldownUntil).toBeNull();
	});

	it('budget spent: the last 5xx is answered as-is', async () => {
		add('claude', 'a');
		const fetchMock = vi.fn(() => Promise.resolve(new Response('bad gateway', { status: 502 })));
		vi.stubGlobal('fetch', fetchMock);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(502);
		expect(fetchMock).toHaveBeenCalledTimes(1 + UPSTREAM_RETRY.maxRetries);
	});

	it('a retry-after longer than the bound is not waited through', async () => {
		add('claude', 'a');
		const fetchMock = vi.fn(() => Promise.resolve(new Response('busy', { status: 503, headers: { 'retry-after': '120' } })));
		vi.stubGlobal('fetch', fetchMock);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('transport failure (fetch rejects) is retried', async () => {
		add('claude', 'a');
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls++;
				if (calls === 1) return Promise.reject(new TypeError('fetch failed'));

				return Promise.resolve(new Response('{"usage":{"input_tokens":1}}', { status: 200 }));
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(calls).toBe(2);
	});

	it('early SSE overloaded_error before output is retried; the client sees only the good stream', async () => {
		add('claude', 'a');
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls++;

				return Promise.resolve(
					calls === 1
						? sse([
								anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
								anthropicEvent('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
							])
						: claudeSuccess.clone()
				);
			})
		);

		const result = await proxyRequest('/v1/messages', claudeStreamBody);
		const text = await result.response.text();

		expect(calls).toBe(2);
		expect(text).toContain('"text":"ok"');
		expect(text).not.toContain('overloaded_error');
	});

	it('Codex 500 then 200 is retried on the same account', async () => {
		const a = add('openai', 'a');
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls++;

				return Promise.resolve(
					calls === 1
						? new Response('{"error":{"type":"server_error"}}', { status: 500 })
						: sse([
								`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`,
								`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`
							])
				);
			})
		);

		const result = await OpenAiClient.proxy(openAiBody);

		expect(calls).toBe(2);
		expect(result.response.status).toBe(200);
		expect(OAuthAccounts.get(a.id)!.cooldownUntil).toBeNull();
	});
});
