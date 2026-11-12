import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountLoginSessions } from 'src/auth/account-login-sessions';
import { UNSUPPORTED_CLIENT_MESSAGE } from 'src/auth/gemini/code-assist-setup';
import { GeminiOAuthClient, GeminiOAuthNotConfiguredError } from 'src/auth/gemini/gemini-oauth-client';
import { GeminiOAuthService } from 'src/auth/gemini/gemini-oauth-service';
import { OAuthAccounts } from 'src/database/oauth-accounts';

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
	it('refuses to start a login, with no session left pending, when no OAuth client is configured', async () => {
		vi.stubEnv('UNGATE_GEMINI_OAUTH_CLIENT_SECRET', '');

		await expect(GeminiOAuthService.startLogin()).rejects.toBeInstanceOf(GeminiOAuthNotConfiguredError);
		expect(AccountLoginSessions.findPending('gemini')).toBeFalsy();
	});

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
			tierId: 'free-tier'
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
		expect(page).toContain('2026-06-18');
		const [account] = OAuthAccounts.list('gemini');
		expect(account).toMatchObject({ providerUserId: 'google-user-1', providerAccountId: null, needsLogin: true });
		expect(OAuthAccounts.view('gemini').accounts[0].availability).toBe('needs_login');
		expect(GeminiOAuthService.getAuthStatus().authenticated).toBe(false);
		expect(UNSUPPORTED_CLIENT_MESSAGE).toContain('Workspace');
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
