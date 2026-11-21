import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountLoginSessions } from 'src/auth/account-login-sessions';
import { CodeAssistSetupClient, UNSUPPORTED_CLIENT_MESSAGE } from 'src/auth/gemini/code-assist-setup';
import { GeminiOAuthClient, GeminiOAuthNotConfiguredError } from 'src/auth/gemini/gemini-oauth-client';
import { GeminiOAuthService } from 'src/auth/gemini/gemini-oauth-service';
import { OAuthAccounts } from 'src/database/oauth-accounts';
import authPlugin from 'src/routes/auth';

import { withPlugin } from '../test-harness';

const realFetch = globalThis.fetch;

interface GoogleStub {
	load: unknown;
	onboard?: unknown;
	tokenStatus?: number;
}

/** Stubs Google's token, userinfo, and Code Assist endpoints; loopback calls go to the real listener. */
function stubGoogle(stub: GoogleStub) {
	const calls: { url: string; body: string }[] = [];
	const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
		const body = init?.body;
		calls.push({ url, body: typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '' });
		if (url.includes('oauth2.googleapis.com/token')) {
			return Promise.resolve(
				new Response(JSON.stringify({ access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 }), {
					status: stub.tokenStatus ?? 200
				})
			);
		}
		if (url.includes('/userinfo')) {
			return Promise.resolve(new Response(JSON.stringify({ id: 'google-user-1', email: 'dev@example.com' })));
		}
		if (url.endsWith(':loadCodeAssist')) return Promise.resolve(new Response(JSON.stringify(stub.load)));
		if (url.endsWith(':onboardUser')) return Promise.resolve(new Response(JSON.stringify(stub.onboard ?? {})));

		return Promise.resolve(new Response('unexpected', { status: 500 }));
	});
	vi.stubGlobal('fetch', fetchMock);

	return calls;
}

async function signIn(): Promise<Response> {
	const { authUrl, sessionId } = await GeminiOAuthService.startLogin();
	const redirectUri = new URL(authUrl).searchParams.get('redirect_uri');
	expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);

	return realFetch(`${redirectUri}?code=auth-code&state=${sessionId}`, { redirect: 'manual' });
}

beforeEach(() => {
	AccountLoginSessions.reset();
	vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_ID', 'test-client.apps.googleusercontent.com');
	vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_SECRET', 'test-client-secret');
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	const pending = AccountLoginSessions.findPending('gemini');
	if (pending) await GeminiOAuthService.cancelLogin(pending);
});

describe('auth-gemini-oauth-lifecycle', () => {
	it('fails closed when neither OAuth credential is supplied', async () => {
		vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_ID', undefined);
		vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_SECRET', undefined);
		await expect(GeminiOAuthService.startLogin()).rejects.toBeInstanceOf(GeminiOAuthNotConfiguredError);
		expect(AccountLoginSessions.findPending('gemini')).toBeFalsy();
	});

	it('requests Antigravity scopes with the configured client', async () => {
		const { authUrl } = await GeminiOAuthService.startLogin();
		const url = new URL(authUrl);
		expect(url.searchParams.get('client_id')).toBe('test-client.apps.googleusercontent.com');
		for (const scope of ['aicode', 'cclog', 'experimentsandconfigs']) {
			expect(url.searchParams.get('scope')).toContain(`https://www.googleapis.com/auth/${scope}`);
		}
	});

	it('accepts an object-shaped project without requiring a current tier', async () => {
		const calls = stubGoogle({ load: { cloudaicompanionProject: { id: 'agy-project' } } });
		const response = await signIn();
		expect(response.status).toBe(302);
		expect(OAuthAccounts.list('gemini')[0].providerAccountId).toBe('agy-project');
		const load = calls.find((call) => call.url.endsWith(':loadCodeAssist'))!;
		expect(load.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
		expect(JSON.parse(load.body)).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } });
		expect(calls.some((call) => call.url.endsWith(':onboardUser'))).toBe(false);
	});

	it('polls onboarding on the daily host with Antigravity control-plane headers', async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(new Response(JSON.stringify({ currentTier: { id: 'free-tier' } })))
				.mockResolvedValueOnce(new Response(JSON.stringify({ done: false })))
				.mockResolvedValueOnce(new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: 'p' } })));
			vi.stubGlobal('fetch', fetchMock);
			const result = CodeAssistSetupClient.setup('test-token');
			await vi.advanceTimersByTimeAsync(2_000);
			const setup = await result;
			expect(setup).toMatchObject({ ok: true, projectId: 'p' });
			for (const [url, init] of fetchMock.mock.calls.slice(1)) {
				expect(url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser');
				const headers = new Headers(init?.headers);
				expect(headers.get('User-Agent')).toContain('antigravity/hub/');
				expect(headers.get('X-Goog-Api-Client')).toBe('gl-node/22.21.1');
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses to start a login, with no session left pending, when no OAuth client is configured', async () => {
		vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_SECRET', '');

		await expect(GeminiOAuthService.startLogin()).rejects.toBeInstanceOf(GeminiOAuthNotConfiguredError);
		expect(AccountLoginSessions.findPending('gemini')).toBeFalsy();
	});

	it.each(['your-client-id', 'test-client.example.com', 'apps.googleusercontent.com.evil'])(
		'treats client id %s as unconfigured, so /auth/gemini/start answers 503 login_not_configured',
		async (clientId) => {
			vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_ID', clientId);
			const warn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);
			const app = await withPlugin(authPlugin);

			const response = await app.inject({ method: 'POST', url: '/auth/gemini/start' });

			expect(response.statusCode).toBe(503);
			expect(response.json()).toMatchObject({ code: 'login_not_configured' });
			expect(AccountLoginSessions.findPending('gemini')).toBeFalsy();
			expect(warn.mock.calls.flat().join(' ')).not.toContain('test-client-secret');
			await app.close();
		}
	);

	it('keeps an account signed in when a refresh finds no OAuth client', async () => {
		vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_ID', '');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(GeminiOAuthClient.refreshToken('g-refresh')).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('builds a Google installed-app authorize URL with PKCE, offline access and the loopback redirect', async () => {
		const { authUrl, sessionId } = await GeminiOAuthService.startLogin();
		const url = new URL(authUrl);

		expect(url.origin).toBe('https://accounts.google.com');
		expect(url.searchParams.get('client_id')).toBe('test-client.apps.googleusercontent.com');
		expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/cloud-platform');
		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBe(sessionId);

		await expect(GeminiOAuthService.startLogin()).rejects.toThrow();
		const cancelled = await GeminiOAuthService.cancelLogin(sessionId);
		expect(cancelled).toBe(true);
	});

	it('exchanges the callback code and stores the Code Assist project and tier on the account', async () => {
		const calls = stubGoogle({
			load: {
				currentTier: { id: 'standard-tier', name: 'Gemini Code Assist Standard' },
				cloudaicompanionProject: 'managed-project-42'
			}
		});

		const response = await signIn();

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toContain('auth_success_gemini');
		const token = calls.find((call) => call.url.includes('oauth2.googleapis.com/token'));
		expect(new URLSearchParams(token?.body).get('code_verifier')).toBeTruthy();
		expect(new URLSearchParams(token?.body).get('client_secret')).toBe('test-client-secret');

		const [account] = OAuthAccounts.list('gemini');
		expect(account).toMatchObject({
			providerUserId: 'google-user-1',
			providerAccountId: 'managed-project-42',
			email: 'dev@example.com',
			planType: 'standard-tier',
			needsLogin: false
		});
		expect(GeminiOAuthService.getAuthStatus()).toEqual({ authenticated: true, email: 'dev@example.com' });

		const valid = await GeminiOAuthService.getValidToken();
		expect(valid).toMatchObject({ accessToken: 'g-access', accountId: 'managed-project-42' });
	});

	it('onboards onto the default tier when Google has no project for the account yet', async () => {
		const calls = stubGoogle({
			load: { allowedTiers: [{ id: 'free-tier', name: 'Free', isDefault: true }] },
			onboard: { done: true, response: { cloudaicompanionProject: { id: 'onboarded-project' } } }
		});

		const response = await signIn();

		expect(response.status).toBe(302);
		expect(JSON.parse(calls.find((call) => call.url.endsWith(':onboardUser'))?.body ?? '{}')).toMatchObject({
			tier_id: 'free-tier',
			metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity' }
		});
		expect(OAuthAccounts.list('gemini')[0]).toMatchObject({ providerAccountId: 'onboarded-project', planType: 'free-tier' });
	});

	it('saves an UNSUPPORTED_CLIENT account as needs-login with the migration message instead of failing generically', async () => {
		stubGoogle({
			load: {
				allowedTiers: [{ id: 'free-tier', isDefault: true }],
				ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'This client is no longer supported' }]
			}
		});

		const response = await signIn();
		const page = await response.text();

		expect(response.status).toBe(400);
		expect(page).toContain('Antigravity');
		const [account] = OAuthAccounts.list('gemini');
		expect(account).toMatchObject({ providerUserId: 'google-user-1', providerAccountId: null, needsLogin: true });
		expect(OAuthAccounts.view('gemini').accounts[0].availability).toBe('needs_login');
		expect(GeminiOAuthService.getAuthStatus().authenticated).toBe(false);
		expect(UNSUPPORTED_CLIENT_MESSAGE).toContain('Antigravity');
	});

	it('rejects a callback whose state does not match the pending session', async () => {
		stubGoogle({ load: {} });
		const { authUrl } = await GeminiOAuthService.startLogin();
		const redirectUri = new URL(authUrl).searchParams.get('redirect_uri');

		const response = await realFetch(`${redirectUri}?code=x&state=forged`, { redirect: 'manual' });

		expect(response.status).toBe(400);
		expect(OAuthAccounts.list('gemini')).toHaveLength(0);
	});

	it('refreshes an expiring token and keeps the stored refresh token when Google omits it', async () => {
		OAuthAccounts.saveLogin(
			'gemini',
			{ accessToken: 'old', refreshToken: 'keep-me', expiresAt: Date.now() + 1_000 },
			{ providerUserId: 'u', providerAccountId: 'p', email: 'u@example.com' },
			[]
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }))))
		);

		const token = await GeminiOAuthService.getValidToken();

		expect(token?.accessToken).toBe('fresh');
		expect(OAuthAccounts.list('gemini')[0].refreshToken).toBe('keep-me');
	});
});
