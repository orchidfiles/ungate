import { config } from 'src/config';
import { OAuthAccounts } from 'src/database/oauth-accounts';
import { logger } from 'src/utils/logger';

import { AccountLoginSessions, LoginConflictError } from '../account-login-sessions';
import { AccountTokenService } from '../account-token-service';

import { GeminiCallbackServer } from './callback-server';
import { CodeAssistSetupClient } from './code-assist-setup';
import { GeminiOAuthClient, requireGeminiOAuthClient } from './gemini-oauth-client';
import { GeminiOAuthUtils } from './gemini-oauth-utils';

import type { OAuthCredentials } from '../base-provider';
import type { AccountLoginCompleteResponse } from '@ungate/shared';
import type { ServerResponse } from 'node:http';

/**
 * Google account sign-in over the Gemini CLI / Code Assist installed-app OAuth flow. The managed
 * Code Assist project id is stored in `providerAccountId` (every inference and quota call needs it);
 * the Google user id is `providerUserId`.
 */
export class GeminiOAuthService {
	private static starting = false;
	private static listenerSession: string | null = null;
	private static redirectUri: string | null = null;
	/** Test hook: fixed callback port (0 = ephemeral). */
	static callbackPort = 0;

	public static async startLogin(accountId?: string): Promise<{ authUrl: string; sessionId: string }> {
		const pending = AccountLoginSessions.findPending('gemini');
		if (this.starting || pending) throw new LoginConflictError(pending ?? '');
		const { clientId } = requireGeminiOAuthClient();
		this.starting = true;
		let sessionId: string | undefined;
		try {
			const { verifier, challenge } = await GeminiOAuthUtils.generatePkce();
			const session = AccountLoginSessions.create('gemini', verifier, accountId);
			sessionId = session.result.sessionId;
			const redirectUri = await GeminiCallbackServer.start(
				(url, path, response) => this.handleCallbackRequest(url, path, response),
				this.callbackPort
			);
			this.listenerSession = sessionId;
			this.redirectUri = redirectUri;
			const oauthConfig = config.gemini.oauth;
			const params = new URLSearchParams({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: redirectUri,
				scope: oauthConfig.scope,
				access_type: 'offline',
				// Forces a refresh token even when the user already granted this client.
				prompt: 'consent',
				code_challenge: challenge,
				code_challenge_method: 'S256',
				state: sessionId
			});

			return { authUrl: `${oauthConfig.authorizeUrl}?${params}`, sessionId };
		} catch (error) {
			if (sessionId) AccountLoginSessions.cancel(sessionId, 'gemini');
			throw error;
		} finally {
			this.starting = false;
		}
	}

	public static async completeLogin(code: string, sessionId: string): Promise<AccountLoginCompleteResponse> {
		const redirectUri = this.listenerSession === sessionId ? this.redirectUri : null;
		const session = AccountLoginSessions.claim(sessionId, 'gemini');
		if (!session) return { ok: false, error: 'Session not found, expired, or already used' };
		try {
			if (!redirectUri) throw new Error('Login callback listener is no longer running; start the login again');
			const tokens = await GeminiOAuthClient.exchangeCode(code, session.verifier, redirectUri);
			if (typeof tokens.access_token !== 'string') throw new Error('Google returned no access token');
			// Identity comes only from Google's userinfo for the freshly issued token.
			const user = await GeminiOAuthClient.userInfo(tokens.access_token);
			if (!user.id) throw new Error('Provider did not return a user identity');
			const setup = await CodeAssistSetupClient.setup(tokens.access_token);
			if (!AccountLoginSessions.pending(session)) return { ok: false, error: 'Login cancelled or expired' };
			const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
			const row = OAuthAccounts.saveLogin(
				'gemini',
				{
					accessToken: tokens.access_token,
					refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
					expiresAt: Date.now() + expiresIn * 1000
				},
				{ providerUserId: user.id, providerAccountId: setup.ok ? setup.projectId : null, email: user.email },
				session.snapshot,
				session.reconnectId
			);
			if (!setup.ok) {
				// Saved so the card shows the account, but it cannot serve requests until Google allows it.
				OAuthAccounts.markNeedsLogin(row.id, row.credentialVersion);
				logger.log(`[accounts] gemini account ${row.id} rejected by Code Assist: ${setup.error}`);
				AccountLoginSessions.finish(session, undefined, setup.error);

				return { ok: false, error: setup.error, accountId: row.id };
			}
			if (setup.tierId) OAuthAccounts.setPlanType(row.id, setup.tierId);
			AccountLoginSessions.finish(session, row.id);

			return { ok: true, email: row.email ?? undefined, accountId: row.id };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Login failed';
			AccountLoginSessions.finish(session, undefined, message);

			return { ok: false, error: message };
		}
	}

	public static getSession(sessionId: string) {
		return AccountLoginSessions.status(sessionId, 'gemini');
	}

	public static async cancelLogin(sessionId: string): Promise<boolean> {
		const cancelled = AccountLoginSessions.cancel(sessionId, 'gemini');
		if (this.listenerSession === sessionId) await this.closeListener();

		return cancelled;
	}

	private static async exchangeRefresh(token: string) {
		const tokens = await GeminiOAuthClient.refreshToken(token);
		if (!tokens || typeof tokens.access_token !== 'string') return null;

		return {
			accessToken: tokens.access_token,
			// Google usually omits refresh_token on refresh; keep the stored one.
			refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : token,
			expiresAt: Date.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000
		};
	}

	public static async getValidToken(accountId?: string): Promise<OAuthCredentials | null> {
		return AccountTokenService.get('gemini', accountId, 60_000, (token) => this.exchangeRefresh(token));
	}

	public static async refreshAccountToken(accountId: string, expectedVersion?: number): Promise<OAuthCredentials | null> {
		return AccountTokenService.refresh('gemini', accountId, (token) => this.exchangeRefresh(token), expectedVersion);
	}

	public static getAuthStatus(): { authenticated: boolean; email?: string } {
		const row = OAuthAccounts.active('gemini');

		return { authenticated: !!row && !row.needsLogin, email: row?.email ?? undefined };
	}

	public static logout(): void {
		const row = OAuthAccounts.active('gemini');
		if (row) OAuthAccounts.remove('gemini', row.id);
	}

	private static async closeListener(): Promise<void> {
		this.listenerSession = null;
		this.redirectUri = null;
		await GeminiCallbackServer.stop();
	}

	private static async handleCallbackRequest(
		requestUrl: string | undefined,
		path: string,
		response: ServerResponse
	): Promise<void> {
		const url = new URL(requestUrl ?? '/', 'http://127.0.0.1');
		if (url.pathname !== path) {
			response.statusCode = 404;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('Not found');

			return;
		}
		const sessionId = url.searchParams.get('state');
		const code = url.searchParams.get('code');
		if (!sessionId || sessionId !== this.listenerSession) {
			response.statusCode = 400;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('Invalid login session');

			return;
		}
		if (!code) {
			const session = AccountLoginSessions.get(sessionId, 'gemini');
			const reason = url.searchParams.has('error') ? 'Provider denied authorization' : 'Missing authorization code';
			if (session) AccountLoginSessions.finish(session, undefined, reason);
		}
		const result: AccountLoginCompleteResponse = code ? await this.completeLogin(code, sessionId) : { ok: false };
		if (result.ok) {
			response.statusCode = 302;
			response.setHeader('Location', GeminiOAuthUtils.successRedirect());
			response.end();
		} else {
			response.statusCode = 400;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end(GeminiOAuthUtils.callbackPage(false, result.error));
		}
		// Old callbacks cannot close a newer session's listener.
		if (this.listenerSession === sessionId) await this.closeListener();
	}
}
