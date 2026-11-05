import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from 'src/config';
import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import anthropicPlugin from 'src/routes/anthropic';
import authPlugin from 'src/routes/auth';
import { UsageFetcher } from 'src/usage/usage-fetcher';
import { AccountUsageStore } from 'src/usage/usage-store';

import { withPlugin } from '../test-harness';

import type { AccountListResponse, SubscriptionProvider } from '@ungate/shared';

const SEC = () => Math.floor(Date.now() / 1000);

function add(provider: SubscriptionProvider, user: string): OAuthAccountRow {
	return OAuthAccounts.saveLogin(
		provider,
		{ accessToken: `token-${user}`, refreshToken: `refresh-${user}`, expiresAt: Date.now() + 3_600_000 },
		{ providerUserId: user, providerAccountId: provider === 'openai' ? `ws-${user}` : null, email: `${user}@example.com` },
		OAuthAccounts.list(provider)
	);
}

function headerOf(init: RequestInit | undefined, name: string): string {
	const headers = (init?.headers ?? {}) as Record<string, string>;
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);

	return key ? headers[key] : '';
}

const urlOf = (input: string | URL | Request): string =>
	typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const claudeUsageBody = (utilization: number) => ({
	five_hour: { utilization, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
	seven_day: { utilization: 30, resets_at: null },
	seven_day_opus: null
});

beforeEach(() => {
	AccountUsageStore.clear();
	UsageFetcher.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('account usage', () => {
	it('fetches Claude usage for every account and throttles repeat fetches', async () => {
		const a = add('claude', 'a');
		const b = add('claude', 'b');
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
			expect(urlOf(input)).toBe(config.anthropic.usageUrl);
			expect(headerOf(init, 'anthropic-beta')).toBe(config.anthropic.usageBeta);
			expect(headerOf(init, 'user-agent')).toMatch(/^claude-cli\//);

			return Promise.resolve(json(claudeUsageBody(headerOf(init, 'authorization') === 'Bearer token-a' ? 10 : 80)));
		});
		const app = await withPlugin(authPlugin);
		try {
			const response = await app.inject({ method: 'POST', url: '/auth/claude/usage/refresh', payload: {} });
			expect(response.statusCode).toBe(200);
			expect(response.body).not.toMatch(/token-/);
			const accounts = response.json<AccountListResponse>().accounts;
			const usageOf = (id: string) => accounts.find((account) => account.id === id)?.usage;
			expect(usageOf(a.id)).toMatchObject({
				source: 'endpoint',
				error: null,
				windows: [{ id: '5h', usedPercent: 10 }, { id: '7d' }]
			});
			expect(usageOf(b.id)?.windows[0]).toMatchObject({ id: '5h', usedPercent: 80 });
			expect(fetchMock).toHaveBeenCalledTimes(2);

			await app.inject({ method: 'POST', url: '/auth/claude/usage/refresh', payload: { accountId: a.id } });
			expect(fetchMock).toHaveBeenCalledTimes(2);

			const list = await app.inject({ method: 'GET', url: '/auth/claude/accounts' });
			expect(list.json<AccountListResponse>().accounts[0].usage?.windows).toHaveLength(2);

			const missing = await app.inject({ method: 'POST', url: '/auth/claude/usage/refresh', payload: { accountId: 'nope' } });
			expect(missing.statusCode).toBe(404);
			const crossProvider = await app.inject({ method: 'POST', url: '/auth/openai/usage/refresh', payload: { accountId: a.id } });
			expect(crossProvider.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it('fetches ChatGPT usage with the workspace header and retries once after a 401 refresh', async () => {
		const a = add('openai', 'a');
		const calls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
			const url = urlOf(input);
			if (url === config.openai.oauth.tokenUrl) {
				calls.push('refresh');

				return Promise.resolve(json({ access_token: 'token-a2', refresh_token: 'refresh-a2', expires_in: 3600 }));
			}
			expect(url).toBe(config.openai.usageUrl);
			expect(headerOf(init, 'chatgpt-account-id')).toBe('ws-a');
			const auth = headerOf(init, 'authorization');
			calls.push(auth);
			if (auth === 'Bearer token-a') return Promise.resolve(json({ error: 'expired' }, 401));

			return Promise.resolve(
				json({
					plan_type: 'pro',
					rate_limit: {
						primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_after_seconds: 600 },
						secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: SEC() + 86400 }
					}
				})
			);
		});
		const app = await withPlugin(authPlugin);
		try {
			const response = await app.inject({ method: 'POST', url: '/auth/openai/usage/refresh', payload: { accountId: a.id } });
			expect(calls).toEqual(['Bearer token-a', 'refresh', 'Bearer token-a2']);
			expect(response.json<AccountListResponse>().accounts[0].usage).toMatchObject({
				planType: 'pro',
				error: null,
				windows: [
					{ id: 'primary', label: '5-hour', usedPercent: 40 },
					{ id: 'secondary', label: 'Weekly', usedPercent: 5 }
				]
			});
			expect(OAuthAccounts.get(a.id)?.needsLogin).toBe(false);
			expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
		} finally {
			await app.close();
		}
	});

	it('records fetch errors without touching account state', async () => {
		const a = add('claude', 'a');
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'boom' }, 500));
		const app = await withPlugin(authPlugin);
		try {
			const response = await app.inject({ method: 'POST', url: '/auth/claude/usage/refresh' });
			expect(response.json<AccountListResponse>().accounts[0].usage).toMatchObject({
				windows: [],
				error: 'Usage request failed (HTTP 500)'
			});
			expect(OAuthAccounts.get(a.id)).toMatchObject({ needsLogin: false, cooldownUntil: null });
		} finally {
			await app.close();
		}
	});

	it('captures rate-limit headers from proxied responses', async () => {
		const a = add('claude', 'a');
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 'msg_1',
					type: 'message',
					role: 'assistant',
					model: 'claude-sonnet-4-6',
					content: [{ type: 'text', text: 'hi' }],
					stop_reason: 'end_turn',
					usage: { input_tokens: 1, output_tokens: 2 }
				}),
				{
					status: 200,
					headers: {
						'content-type': 'application/json',
						'anthropic-ratelimit-unified-5h-utilization': '0.33',
						'anthropic-ratelimit-unified-5h-reset': String(SEC() + 1800)
					}
				}
			)
		);
		const proxy = await withPlugin(anthropicPlugin);
		try {
			const response = await proxy.inject({
				method: 'POST',
				url: '/v1/messages',
				headers: { 'x-api-key': 'secret' },
				payload: { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }
			});
			expect(response.statusCode).toBe(200);
		} finally {
			await proxy.close();
		}

		const app = await withPlugin(authPlugin);
		try {
			const list = await app.inject({ method: 'GET', url: '/auth/claude/accounts' });
			const usage = list.json<AccountListResponse>().accounts.find((account) => account.id === a.id)?.usage;
			expect(usage).toMatchObject({ source: 'headers', windows: [{ id: '5h', usedPercent: 33 }] });

			await app.inject({ method: 'DELETE', url: `/auth/claude/accounts/${a.id}` });
			expect(AccountUsageStore.get(a.id)).toBeUndefined();
		} finally {
			await app.close();
		}
	});
});
