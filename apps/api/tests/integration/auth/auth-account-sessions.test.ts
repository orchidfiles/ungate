import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountLoginSessions } from 'src/auth/account-login-sessions';
import { AccountTokenService } from 'src/auth/account-token-service';
import { OAuth } from 'src/auth/oauth';
import { OpenAICallbackServer } from 'src/auth/openai/callback-server';
import { OpenAIOAuthClient } from 'src/auth/openai/oauth-client';
import { OpenAIOAuthService } from 'src/auth/openai/openai-oauth-service';
import { OAuthAccounts } from 'src/database/oauth-accounts';
import { proxyRequest } from 'src/proxy/anthropic-client';

const add = (id: string) =>
	OAuthAccounts.saveLogin(
		'claude',
		{ accessToken: `old-${id}`, refreshToken: `refresh-${id}`, expiresAt: 0 },
		{ providerUserId: id, email: `${id}@example.com` },
		OAuthAccounts.list('claude')
	);

const claudeTokens = (uuid: string, access = 'new') =>
	new Response(
		JSON.stringify({
			access_token: access,
			refresh_token: `${access}-r`,
			expires_in: 3600,
			account: { uuid, email_address: `${uuid}@example.com` }
		})
	);

const idToken = (sub: string, workspace = 'ws') => {
	const payload = Buffer.from(
		JSON.stringify({
			sub,
			email: `${sub}@example.com`,
			'https://api.openai.com/auth': { chatgpt_account_id: workspace, organizations: [] }
		})
	).toString('base64url');

	return `h.${payload}.s`;
};

beforeEach(() => {
	AccountLoginSessions.reset();
	vi.spyOn(OpenAICallbackServer, 'start').mockResolvedValue();
	vi.spyOn(OpenAICallbackServer, 'stop').mockResolvedValue();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('account-scoped tokens', () => {
	it('deduplicates refresh, preserves metadata, and remains pinned after manual selection', async () => {
		const a = add('a');
		const b = add('b');
		let resolve!: (value: { accessToken: string; expiresAt: number }) => void;
		const refresh = vi.fn(
			() =>
				new Promise<{ accessToken: string; expiresAt: number }>((done) => {
					resolve = done;
				})
		);
		const first = AccountTokenService.refresh('claude', a.id, refresh, a.credentialVersion);
		const second = AccountTokenService.refresh('claude', a.id, refresh, a.credentialVersion);
		OAuthAccounts.select('claude', b.id);
		resolve({ accessToken: 'new-a', expiresAt: Date.now() + 60_000 });
		const firstResult = await first;
		const secondResult = await second;
		expect(firstResult?.localAccountId).toBe(a.id);
		expect(secondResult?.email).toBe('a@example.com');
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(OAuthAccounts.get(a.id)?.refreshToken).toBe('refresh-a');
		expect(OAuthAccounts.active('claude')?.accessToken).toBe('old-b');
	});

	it('reuses a newer generation instead of refreshing twice for a stale 401', async () => {
		const a = add('a');
		const refresh = vi.fn(() => Promise.resolve({ accessToken: 'gen2', expiresAt: Date.now() + 60_000 }));
		await AccountTokenService.refresh('claude', a.id, refresh, a.credentialVersion);
		const again = await AccountTokenService.refresh('claude', a.id, refresh, a.credentialVersion);
		expect(again?.accessToken).toBe('gen2');
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('does not resurrect deleted accounts after refresh', async () => {
		const a = add('a');
		let resolve!: (value: { accessToken: string; expiresAt: number }) => void;
		const promise = AccountTokenService.refresh(
			'claude',
			a.id,
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		OAuthAccounts.remove('claude', a.id);
		resolve({ accessToken: 'late', expiresAt: 100 });
		const late = await promise;
		expect(late).toBeNull();
		expect(OAuthAccounts.get(a.id)).toBeUndefined();
	});

	it('marks needs-login when the provider rejects the refresh token', async () => {
		const a = add('a');
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })))
		);
		const refreshed = await OAuth.refreshAccountToken(a.id);
		expect(refreshed).toBeNull();
		expect(OAuthAccounts.get(a.id)?.needsLogin).toBe(true);
		expect(OAuth.getAuthStatus().authenticated).toBe(false);
		expect(OAuthAccounts.view('claude').accounts[0].availability).toBe('needs_login');
	});

	it('pins the Claude 401 retry to the account the request used', async () => {
		const a = add('a');
		const b = add('b');
		OAuthAccounts.updateCredentials(a.id, a.credentialVersion, {
			accessToken: 'live-a',
			refreshToken: 'refresh-a',
			expiresAt: Date.now() + 3_600_000
		});
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init: RequestInit) => {
				if (url.includes('/oauth/token')) {
					// Manual switch lands while the refresh is in flight.
					OAuthAccounts.select('claude', b.id);

					return Promise.resolve(
						new Response(JSON.stringify({ access_token: 'refreshed-a', refresh_token: 'refresh-a2', expires_in: 3600 }))
					);
				}
				seen.push(
					(init.headers as Record<string, string>).Authorization ?? (init.headers as Record<string, string>).authorization
				);

				return Promise.resolve(
					seen.length === 1 ? new Response('{}', { status: 401 }) : new Response('{"usage":{}}', { status: 200 })
				);
			})
		);
		const result = await proxyRequest('/v1/messages', { model: 'm', messages: [], max_tokens: 1 } as never, {});
		expect(result.response.status).toBe(200);
		expect(seen).toEqual(['Bearer live-a', 'Bearer refreshed-a']);
		expect(OAuthAccounts.get(b.id)?.accessToken).toBe('old-b');
	});
});

describe('Claude login sessions', () => {
	it('tracks new login independently from an existing account and cancels an in-flight exchange', async () => {
		add('a');
		const login = await OAuth.startLogin();
		expect(OAuth.getSession(login.sessionId)?.status).toBe('pending');
		let resolve!: (response: Response) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(
				() =>
					new Promise<Response>((done) => {
						resolve = done;
					})
			)
		);
		const completion = OAuth.completeLogin(`code#${login.sessionId}`, login.sessionId);
		OAuth.cancelLogin(login.sessionId);
		resolve(claudeTokens('b'));
		const completed = await completion;
		expect(completed.ok).toBe(false);
		expect(OAuth.getSession(login.sessionId)?.status).toBe('cancelled');
		expect(OAuthAccounts.list('claude')).toHaveLength(1);
	});

	it('adds a second account without changing the active one and rejects session reuse', async () => {
		const a = add('a');
		const login = await OAuth.startLogin();
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(claudeTokens('b')))
		);
		const result = await OAuth.completeLogin(`code#${login.sessionId}`, login.sessionId);
		expect(result).toMatchObject({ ok: true, email: 'b@example.com' });
		expect(OAuth.getSession(login.sessionId)).toMatchObject({ status: 'succeeded', accountId: result.accountId });
		expect(OAuthAccounts.active('claude')?.id).toBe(a.id);
		const reused = await OAuth.completeLogin('code', login.sessionId);
		expect(reused.ok).toBe(false);
		expect(OAuthAccounts.list('claude')).toHaveLength(2);
	});

	it('updates the same identity instead of duplicating it and rejects a state mismatch', async () => {
		const a = add('a');
		const login = await OAuth.startLogin();
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(claudeTokens('a', 'fresh')))
		);
		const mismatch = await OAuth.completeLogin('code#other-state', login.sessionId);
		expect(mismatch.error).toMatch(/state/);
		const retry = await OAuth.startLogin();
		const result = await OAuth.completeLogin(`code#${retry.sessionId}`, retry.sessionId);
		expect(result.accountId).toBe(a.id);
		expect(OAuthAccounts.list('claude')).toHaveLength(1);
		expect(OAuthAccounts.get(a.id)?.accessToken).toBe('fresh');
	});

	it('rejects reconnecting another identity', async () => {
		const a = add('a');
		const login = await OAuth.startLogin(a.id);
		expect(OAuth.getSession(login.sessionId)?.reconnectAccountId).toBe(a.id);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(claudeTokens('b')))
		);
		const reconnect = await OAuth.completeLogin('code', login.sessionId);
		expect(reconnect.ok).toBe(false);
		expect(OAuth.getSession(login.sessionId)?.status).toBe('failed');
		expect(OAuthAccounts.get(a.id)?.accessToken).toBe('old-a');
	});
});

describe('OpenAI login sessions', () => {
	it('rejects overlapping logins and releases the slot on cancellation', async () => {
		const login = await OpenAIOAuthService.startLogin();
		await expect(OpenAIOAuthService.startLogin()).rejects.toMatchObject({ pendingSessionId: login.sessionId });
		await OpenAIOAuthService.cancelLogin(login.sessionId);
		expect(OpenAIOAuthService.getSession(login.sessionId)?.status).toBe('cancelled');
		const lateCompletion = await OpenAIOAuthService.completeLogin('code', login.sessionId);
		expect(lateCompletion.ok).toBe(false);
		const next = await OpenAIOAuthService.startLogin();
		await OpenAIOAuthService.cancelLogin(next.sessionId);
	});

	it('completes a new login by session even when another account is already connected', async () => {
		OAuthAccounts.saveLogin('openai', { accessToken: 'a' }, { providerUserId: 'a', providerAccountId: 'ws' }, []);
		const login = await OpenAIOAuthService.startLogin();
		// Polling must not treat the existing connected account as completion of this login.
		expect(OpenAIOAuthService.getAuthStatus().authenticated).toBe(true);
		expect(OpenAIOAuthService.getSession(login.sessionId)?.status).toBe('pending');
		vi.spyOn(OpenAIOAuthClient, 'exchangeCode').mockResolvedValue({
			access_token: 'b-access',
			refresh_token: 'b-refresh',
			id_token: idToken('b'),
			expires_in: 3600
		});
		const result = await OpenAIOAuthService.completeLogin('code', login.sessionId);
		expect(result.ok).toBe(true);
		const row = OAuthAccounts.get(result.accountId)!;
		expect(row).toMatchObject({ providerUserId: 'b', providerAccountId: 'ws', email: 'b@example.com' });
		expect(OpenAIOAuthService.getSession(login.sessionId)).toMatchObject({ status: 'succeeded', accountId: row.id });
		expect(OAuthAccounts.active('openai')?.accessToken).toBe('a');
	});

	it('fails the session when the id token has no user identity', async () => {
		const login = await OpenAIOAuthService.startLogin();
		vi.spyOn(OpenAIOAuthClient, 'exchangeCode').mockResolvedValue({ access_token: 'x', id_token: 'not-a-jwt' });
		const noIdentity = await OpenAIOAuthService.completeLogin('code', login.sessionId);
		expect(noIdentity.ok).toBe(false);
		expect(OpenAIOAuthService.getSession(login.sessionId)?.status).toBe('failed');
		expect(OAuthAccounts.list('openai')).toHaveLength(0);
	});

	it('reports an unreachable token endpoint instead of a generic exchange failure', async () => {
		const login = await OpenAIOAuthService.startLogin();
		const timeout = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: timeout })));
		const result = await OpenAIOAuthService.completeLogin('code', login.sessionId);
		expect(result).toEqual({
			ok: false,
			error: 'Could not reach auth.openai.com (UND_ERR_CONNECT_TIMEOUT). Check your connection and sign in again.'
		});
		expect(OpenAIOAuthService.getSession(login.sessionId)?.status).toBe('failed');
	});

	it('reports the provider reason when the token endpoint rejects the code', async () => {
		const login = await OpenAIOAuthService.startLogin();
		const body = { error: { message: 'Could not validate your token. Please try signing in again.', code: 'token_expired' } };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 401 })));
		const result = await OpenAIOAuthService.completeLogin('code', login.sessionId);
		expect(result).toEqual({
			ok: false,
			error: 'OpenAI rejected the sign-in (401): Could not validate your token. Please try signing in again.'
		});
	});

	it('refreshes through the account-scoped service and keeps identity metadata', async () => {
		const row = OAuthAccounts.saveLogin(
			'openai',
			{ accessToken: 'old', refreshToken: 'r1', expiresAt: 0 },
			{ providerUserId: 'a', providerAccountId: 'ws', email: 'a@example.com' },
			[]
		);
		vi.spyOn(OpenAIOAuthClient, 'refreshToken').mockResolvedValue({ access_token: 'new', expires_in: 60 });
		const token = await OpenAIOAuthService.getValidToken();
		expect(token).toMatchObject({ accessToken: 'new', refreshToken: 'r1', accountId: 'ws', localAccountId: row.id });
	});
});
