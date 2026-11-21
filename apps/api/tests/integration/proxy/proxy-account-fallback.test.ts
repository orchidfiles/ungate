import { afterEach, describe, expect, it, vi } from 'vitest';

import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import { UPSTREAM_RETRY } from 'src/proxy/account-fallback';
import { proxyRequest } from 'src/proxy/anthropic-client';
import { OpenAiClient } from 'src/proxy/openai-client';

import type { SubscriptionProvider } from '@ungate/shared';

const SEC = () => Math.floor(Date.now() / 1000);

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

/**
 * A rejected upstream body that never ends: the JSON error is followed by an endless filler stream.
 * The coordinator must classify from a bounded prefix and cancel (release) the rest.
 */
function trackedResponse(body: string, init: ResponseInit): { response: Response; cancelled: () => boolean } {
	let wasCancelled = false;
	let sentHead = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new TextEncoder().encode(sentHead ? ' '.repeat(16 * 1024) : body));
			sentHead = true;
		},
		cancel() {
			wasCancelled = true;
		}
	});

	return { response: new Response(stream, init), cancelled: () => wasCancelled };
}

const claudeUsageLimit = (resetSec = SEC() + 3600) => ({
	body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage limit reached' } }),
	init: {
		status: 429,
		headers: {
			'content-type': 'application/json',
			'content-length': '999',
			'anthropic-ratelimit-unified-status': 'rejected',
			'anthropic-ratelimit-unified-reset': String(resetSec),
			'retry-after': '3600'
		}
	}
});

const codexUsageLimit = (resetSec?: number) =>
	new Response(
		JSON.stringify({
			error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: resetSec }
		}),
		{ status: 429, headers: { 'content-type': 'application/json' } }
	);

const codexSse = (text: string) =>
	new Response(
		[
			`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
			`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`
		].join(''),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);

const claudeBody = { model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } as never;
const openAiBody = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: false } as never;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Claude account fallback (proxyRequest)', () => {
	it('A limited → B succeeds, becomes active, and A is cooled down with the upstream reset', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const reset = SEC() + 3600;
		const limited = claudeUsageLimit(reset);
		const rejected = trackedResponse(limited.body, limited.init);
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));

				return Promise.resolve(
					seen.length === 1 ? rejected.response : new Response('{"usage":{"input_tokens":1}}', { status: 200 })
				);
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer token-a', 'Bearer token-b']);
		expect(rejected.cancelled()).toBe(true);
		const policy = OAuthAccounts.policy('claude');
		expect(policy.activeAccountId).toBe(b.id);
		expect(policy.lastSwitchReason).toBe('anthropic_usage_limit');
		const cooled = OAuthAccounts.get(a.id)!;
		expect(cooled.cooldownUntil).toBe(reset * 1000);
		expect(cooled.cooldownEstimated).toBe(false);
		expect(cooled.cooldownReason).toBe('anthropic_usage_limit');
	});

	it('all accounts limited → provider-compatible 429 with earliest retry time and safe retry-after', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const resetA = SEC() + 7200;
		const resetB = SEC() + 1800;
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				calls++;
				const limited = claudeUsageLimit(calls === 1 ? resetA : resetB);

				return Promise.resolve(new Response(limited.body, limited.init));
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(calls).toBe(2);
		expect(result.response.status).toBe(429);
		expect(result.response.headers.get('content-length')).toBeNull();
		const retryAfter = Number(result.response.headers.get('retry-after'));
		expect(retryAfter).toBeGreaterThan(1700);
		expect(retryAfter).toBeLessThanOrEqual(1800);
		// Claude Code reads these as a usage limit and, with a reset this far out, stops retrying.
		expect(result.response.headers.get('anthropic-ratelimit-unified-status')).toBe('rejected');
		expect(result.response.headers.get('anthropic-ratelimit-unified-reset')).toBe(String(resetB));
		expect(result.response.headers.get('x-should-retry')).toBe('false');
		const json: { type: string; error: { type: string; message: string } } = await result.response.json();
		expect(json.type).toBe('error');
		expect(json.error.type).toBe('rate_limit_error');
		expect(json.error.message).toContain('All saved Claude subscription accounts');
		expect(json.error.message).toContain(new Date(resetB * 1000).toISOString());
		expect(OAuthAccounts.earliestCooldownEnd('claude')).toBe(resetB * 1000);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBe(resetA * 1000);
		expect(OAuthAccounts.get(b.id)?.cooldownUntil).toBe(resetB * 1000);
		// The policy still points at the last account it switched to; no account is tried twice.
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(b.id);
	});

	it('auto-switch off → no switch, but the cooldown is recorded and a clear 429 is returned', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		OAuthAccounts.setAutoSwitch('claude', false);
		const fetchMock = vi.fn(() => {
			const limited = claudeUsageLimit();

			return Promise.resolve(new Response(limited.body, limited.init));
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.response.status).toBe(429);
		const json: { error: { message: string } } = await result.response.json();
		expect(json.error.message).toContain('automatic account switching is off');
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(a.id);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeGreaterThan(Date.now());
	});

	it('ordinary 429 (no unified rejection) and 5xx never rotate or cool down', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }), {
					status: 429,
					headers: { 'retry-after': '7', 'x-should-retry': 'true' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
					status: 529
				})
			)
			.mockResolvedValueOnce(new Response('upstream down', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);

		const throttled = await proxyRequest('/v1/messages', claudeBody);
		expect(throttled.response.status).toBe(429);
		expect(throttled.response.headers.get('retry-after')).toBe('7');
		expect(throttled.response.headers.get('x-should-retry')).toBe('true');
		const throttledJson: { error: { message: string } } = await throttled.response.json();
		expect(throttledJson.error.message).toBe('Slow down');

		// With the transient retry budget off, a 5xx is answered as-is (retries: proxy-upstream-retry.test.ts).
		const savedRetries = UPSTREAM_RETRY.maxRetries;
		UPSTREAM_RETRY.maxRetries = 0;
		try {
			const overloaded = await proxyRequest('/v1/messages', claudeBody);
			expect(overloaded.response.status).toBe(529);
			const unavailable = await proxyRequest('/v1/messages', claudeBody);
			expect(unavailable.response.status).toBe(503);
		} finally {
			UPSTREAM_RETRY.maxRetries = savedRetries;
		}

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(a.id);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
	});

	it('fallback CAS never overrides a concurrent manual selection', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const c = add('claude', 'c');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));
				if (seen.length === 1) {
					// The user manually picks C while the request on A is in flight.
					OAuthAccounts.select('claude', c.id);
					const limited = claudeUsageLimit();

					return Promise.resolve(new Response(limited.body, limited.init));
				}

				return Promise.resolve(new Response('{"usage":{}}', { status: 200 }));
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		// The request follows the user's newer selection (C), never CAS-switching to B.
		expect(seen).toEqual(['Bearer token-a', 'Bearer token-c']);
		const policy = OAuthAccounts.policy('claude');
		expect(policy.activeAccountId).toBe(c.id);
		expect(policy.lastSwitchReason).toBe('manual');
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeGreaterThan(Date.now());
		expect(OAuthAccounts.get(b.id)?.cooldownUntil).toBeNull();
	});

	it('skips cooling-down and needs-login accounts without sending to them', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const c = add('claude', 'c');
		OAuthAccounts.markNeedsLogin(b.id, b.credentialVersion, 'refresh_rejected');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));
				if (seen.length === 1) {
					const limited = claudeUsageLimit();

					return Promise.resolve(new Response(limited.body, limited.init));
				}

				return Promise.resolve(new Response('{"usage":{}}', { status: 200 }));
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer token-a', 'Bearer token-c']);
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(c.id);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).not.toBeNull();
	});

	it('keeps the legacy 401 when there is no usable account', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rotates past a needs-login active account instead of answering 401', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		OAuthAccounts.markNeedsLogin(a.id, a.credentialVersion, 'refresh_rejected');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				seen.push(authOf(init));

				return Promise.resolve(new Response('{"usage":{}}', { status: 200 }));
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer token-b']);
		const policy = OAuthAccounts.policy('claude');
		expect(policy.activeAccountId).toBe(b.id);
		expect(policy.lastSwitchReason).toBe('auth');
	});

	it('a 401 that survives the refresh marks the account needs-login and rotates with reason auth', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const seen: string[] = [];
		const events: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
			if (typeof line === 'string' && line.startsWith('{')) events.push(line);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				if (url.includes('/oauth/token')) {
					expect(init?.signal).toBeInstanceOf(AbortSignal);

					return Promise.resolve(
						new Response(JSON.stringify({ access_token: 'refreshed-a', refresh_token: 'refresh-a2', expires_in: 3600 }))
					);
				}
				seen.push(authOf(init));

				return Promise.resolve(
					authOf(init) === 'Bearer token-b'
						? new Response('{"usage":{}}', { status: 200 })
						: new Response('{"type":"error","error":{"type":"authentication_error","message":"revoked"}}', { status: 401 })
				);
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer token-a', 'Bearer refreshed-a', 'Bearer token-b']);
		expect(OAuthAccounts.get(a.id)?.needsLogin).toBe(true);
		expect(OAuthAccounts.policy('claude').activeAccountId).toBe(b.id);
		expect(OAuthAccounts.policy('claude').lastSwitchReason).toBe('auth');
		expect(events.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual({
			event: 'account_needs_login',
			provider: 'claude',
			accountId: a.id,
			cause: 'auth_rejected_after_refresh'
		});
	});

	it('answers the upstream 401 when every account is rejected after refresh', async () => {
		const a = add('claude', 'a');
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) =>
				Promise.resolve(
					url.includes('/oauth/token')
						? new Response(JSON.stringify({ access_token: 'refreshed-a', refresh_token: 'refresh-a2', expires_in: 3600 }))
						: new Response('{"type":"error","error":{"type":"authentication_error","message":"revoked"}}', { status: 401 })
				)
			)
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(401);
		expect(OAuthAccounts.get(a.id)?.needsLogin).toBe(true);
	});

	it('a failed refresh rotates without marking the account needs-login', async () => {
		const a = add('claude', 'a');
		add('claude', 'b');
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				if (url.includes('/oauth/token')) return Promise.resolve(new Response('busy', { status: 503 }));

				return Promise.resolve(
					authOf(init) === 'Bearer token-b'
						? new Response('{"usage":{}}', { status: 200 })
						: new Response('{"type":"error","error":{"type":"authentication_error"}}', { status: 401 })
				);
			})
		);

		const result = await proxyRequest('/v1/messages', claudeBody);

		expect(result.response.status).toBe(200);
		expect(OAuthAccounts.get(a.id)?.needsLogin).toBe(false);
	});
});

describe('ChatGPT Codex account fallback (OpenAiClient.proxy)', () => {
	it('A limited → B succeeds and becomes active; uses the pinned workspace header', async () => {
		const a = add('openai', 'a');
		const b = add('openai', 'b');
		const reset = SEC() + 900;
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				const headers = init?.headers as Record<string, string>;
				seen.push(`${headers.authorization}|${headers['chatgpt-account-id']}`);

				return Promise.resolve(seen.length === 1 ? codexUsageLimit(reset) : codexSse('hello from b'));
			})
		);

		const result = await OpenAiClient.proxy(openAiBody);

		expect(result.response.status).toBe(200);
		const json: { choices: { message: { content: string } }[] } = await result.response.json();
		expect(json.choices[0].message.content).toBe('hello from b');
		expect(seen).toEqual(['Bearer token-a|ws-a', 'Bearer token-b|ws-b']);
		expect(OAuthAccounts.policy('openai').activeAccountId).toBe(b.id);
		expect(OAuthAccounts.get(a.id)).toMatchObject({
			cooldownUntil: reset * 1000,
			cooldownEstimated: false,
			cooldownReason: 'codex_usage_limit_reached'
		});
	});

	it('all limited → 429 with earliest (estimated) retry time', async () => {
		add('openai', 'a');
		add('openai', 'b');
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(codexUsageLimit()))
		);

		const before = Date.now();
		const result = await OpenAiClient.proxy(openAiBody);

		expect(result.response.status).toBe(429);
		expect(result.context.source).toBe('error');
		const json: { error: { message: string; type: string } } = await result.response.json();
		expect(json.error.type).toBe('usage_limit_reached');
		expect(json.error.message).toContain('All saved ChatGPT subscription accounts');
		expect(json.error.message).toContain('(estimated)');
		const earliest = OAuthAccounts.earliestCooldownEnd('openai')!;
		expect(earliest).toBeGreaterThanOrEqual(before + 60_000);
		expect(earliest).toBeLessThanOrEqual(Date.now() + 60_000);
		// Codex shows the reset time from `resets_at` (epoch seconds).
		const body = json as { error: { resets_at?: number } };
		expect(body.error.resets_at).toBe(Math.ceil(earliest / 1000));
		expect(result.response.headers.get('anthropic-ratelimit-unified-status')).toBeNull();
		expect(Number(result.response.headers.get('retry-after'))).toBeLessThanOrEqual(60);
	});

	it('ordinary rate_limit_exceeded 429 does not rotate and keeps upstream detail', async () => {
		const a = add('openai', 'a');
		add('openai', 'b');
		const fetchMock = vi.fn(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({ error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'Too many requests' } }),
					{
						status: 429,
						headers: { 'retry-after': '3', 'content-encoding': 'gzip', 'content-length': '5' }
					}
				)
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await OpenAiClient.proxy(openAiBody);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.response.status).toBe(429);
		expect(result.response.headers.get('retry-after')).toBe('3');
		expect(result.response.headers.get('content-encoding')).toBeNull();
		const json: unknown = await result.response.json();
		expect(json).toEqual({
			error: { message: 'Too many requests', type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' }
		});
		expect(OAuthAccounts.policy('openai').activeAccountId).toBe(a.id);
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
	});

	it('a Codex 401 after refresh rotates to the next account', async () => {
		const a = add('openai', 'a');
		const b = add('openai', 'b');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				if (url.includes('/oauth/token')) {
					expect(init?.signal).toBeInstanceOf(AbortSignal);

					return Promise.resolve(
						new Response(JSON.stringify({ access_token: 'refreshed-a', refresh_token: 'refresh-a2', expires_in: 3600 }))
					);
				}
				const headers = init?.headers as Record<string, string>;
				seen.push(headers.authorization);

				return Promise.resolve(
					headers.authorization === 'Bearer token-b' ? codexSse('hello from b') : new Response('{}', { status: 401 })
				);
			})
		);

		const result = await OpenAiClient.proxy(openAiBody);

		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer token-a', 'Bearer refreshed-a', 'Bearer token-b']);
		expect(OAuthAccounts.get(a.id)?.needsLogin).toBe(true);
		expect(OAuthAccounts.policy('openai').activeAccountId).toBe(b.id);
	});
});
