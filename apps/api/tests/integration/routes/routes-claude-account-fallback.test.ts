import { afterEach, describe, expect, it, vi } from 'vitest';

import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import anthropicPlugin from 'src/routes/anthropic';
import openaiPlugin from 'src/routes/openai';

import { withPlugin } from '../test-harness';

import type { FastifyPluginCallback } from 'fastify';

/**
 * End-to-end over both Claude HTTP entry points (no proxy mocks): the real `proxyRequest`
 * account fallback must behave identically behind `/v1/messages` and `/v1/chat/completions`.
 */
const SEC = () => Math.floor(Date.now() / 1000);

function addClaude(user: string): OAuthAccountRow {
	return OAuthAccounts.saveLogin(
		'claude',
		{ accessToken: `token-${user}`, refreshToken: `refresh-${user}`, expiresAt: Date.now() + 3_600_000 },
		{ providerUserId: user, providerAccountId: null, email: `${user}@example.com` },
		OAuthAccounts.list('claude')
	);
}

function authOf(init: RequestInit | undefined): string {
	const headers = (init?.headers ?? {}) as Record<string, string>;

	return headers.Authorization ?? headers.authorization ?? '';
}

const usageLimited = (resetSec: number) =>
	new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage limit reached' } }), {
		status: 429,
		headers: {
			'content-type': 'application/json',
			'anthropic-ratelimit-unified-status': 'rejected',
			'anthropic-ratelimit-unified-reset': String(resetSec)
		}
	});

const anthropicOk = () =>
	new Response(
		JSON.stringify({
			id: 'msg_1',
			type: 'message',
			role: 'assistant',
			model: 'claude-sonnet-4-6',
			content: [{ type: 'text', text: 'from B' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 1, output_tokens: 2 }
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);

interface ClaudeEndpoint {
	name: string;
	plugin: FastifyPluginCallback;
	url: string;
	payload: Record<string, unknown>;
	headers: Record<string, string>;
}

const endpoints: ClaudeEndpoint[] = [
	{
		name: '/v1/messages',
		plugin: anthropicPlugin,
		url: '/v1/messages',
		payload: { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
		headers: { 'x-api-key': 'secret' }
	},
	{
		name: '/v1/chat/completions (Claude path)',
		plugin: openaiPlugin,
		url: '/v1/chat/completions',
		payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: false },
		headers: { authorization: 'Bearer secret' }
	}
];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe.each(endpoints)('Claude account fallback through $name', ({ plugin, url, payload, headers }) => {
	it('A limited → B answers; B becomes active and A is cooled down', async () => {
		const a = addClaude('a');
		const b = addClaude('b');
		const resetA = SEC() + 3600;
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				const auth = authOf(init);
				seen.push(auth);

				return Promise.resolve(auth.includes('token-a') ? usageLimited(resetA) : anthropicOk());
			})
		);

		const app = await withPlugin(plugin, { apiKey: 'secret' });
		try {
			const response = await app.inject({ method: 'POST', url, headers, payload });

			expect(response.statusCode).toBe(200);
			expect(response.body).toContain('from B');
			expect(seen).toEqual(['Bearer token-a', 'Bearer token-b']);
			expect(OAuthAccounts.policy('claude')).toMatchObject({ activeAccountId: b.id });
			expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBe(resetA * 1000);
		} finally {
			await app.close();
		}
	});

	it('all accounts limited → 429 with a safe retry-after, each account tried once', async () => {
		addClaude('a');
		addClaude('b');
		const resetSec = SEC() + 1800;
		const fetchMock = vi.fn(() => Promise.resolve(usageLimited(resetSec)));
		vi.stubGlobal('fetch', fetchMock);

		const app = await withPlugin(plugin, { apiKey: 'secret' });
		try {
			const response = await app.inject({ method: 'POST', url, headers, payload });

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(response.statusCode).toBe(429);
			const retryAfter = Number(response.headers['retry-after']);
			expect(retryAfter).toBeGreaterThan(1700);
			expect(retryAfter).toBeLessThanOrEqual(1800);
			expect(response.body).toContain('All saved Claude subscription accounts');
		} finally {
			await app.close();
		}
	});
});
