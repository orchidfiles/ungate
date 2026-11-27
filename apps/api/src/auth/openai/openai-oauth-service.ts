import { config } from 'src/config';
import { OAuthAccounts } from 'src/database/oauth-accounts';

import { AccountLoginSessions, LoginConflictError } from '../account-login-sessions';
import { AccountTokenService } from '../account-token-service';

import { OpenAICallbackServer } from './callback-server';
import { OpenAIOAuthClient } from './oauth-client';
import { OpenAIOAuthUtils } from './openai-oauth-utils';

import type { OAuthCredentials } from '../base-provider';
import type { AccountLoginCompleteResponse } from '@ungate/shared';
import type { ServerResponse } from 'node:http';

export class OpenAIOAuthService {
	private static starting = false;
	private static listenerSession: string | null = null;

	/**
	 * Starts a session-scoped login. Only one OpenAI login may be pending because the provider's
	 * fixed redirect URI owns a single local callback listener; overlapping starts throw
	 * `LoginConflictError` instead of silently replacing the listener.
	 */
	public static async startLogin(accountId?: string): Promise<{ authUrl: string; sessionId: string }> {
		const pending = AccountLoginSessions.findPending('openai');
		if (this.starting || pending) throw new LoginConflictError(pending ?? '');
		this.starting = true;
		let sessionId: string | undefined;
		try {
			const { verifier, challenge } = await OpenAIOAuthUtils.generatePkce();
			const session = AccountLoginSessions.create('openai', verifier, accountId);
			sessionId = session.result.sessionId;
			await OpenAICallbackServer.stop();
			await OpenAICallbackServer.start((url, path, response) => this.handleCallbackRequest(url, path, response));
			this.listenerSession = sessionId;
			const oauthConfig = config.openai.oauth;
			const params = new URLSearchParams({
				response_type: 'code',
				client_id: oauthConfig.clientId,
				redirect_uri: oauthConfig.redirectUri,
				scope: oauthConfig.scope,
				code_challenge: challenge,
				code_challenge_method: oauthConfig.codeChallengeMethod,
				...oauthConfig.extraParams,
				state: sessionId
			});

			return { authUrl: `${oauthConfig.authorizeUrl}?${params}`, sessionId };
		} catch (error) {
			if (sessionId) AccountLoginSessions.cancel(sessionId, 'openai');
			throw error;
		} finally {
			this.starting = false;
		}
	}

	public static async completeLogin(code: string, sessionId: string): Promise<AccountLoginCompleteResponse> {
		const session = AccountLoginSessions.claim(sessionId, 'openai');
		if (!session) return { ok: false, error: 'Session not found, expired, or already used' };
		try {
			const tokens = await OpenAIOAuthClient.exchangeCode(code, session.verifier);
			if (typeof tokens.access_token !== 'string' || typeof tokens.id_token !== 'string')
				throw new Error('OpenAI returned no access or id token');
			// Identity is accepted only from the token endpoint response, never client-submitted claims.
			const parsed = OpenAIOAuthUtils.parseIdToken(tokens.id_token);
			if (!parsed.userId) throw new Error('Provider did not return a user identity');
			if (!AccountLoginSessions.pending(session)) return { ok: false, error: 'Login cancelled or expired' };
			const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
			const row = OAuthAccounts.saveLogin(
				'openai',
				{
					accessToken: tokens.access_token,
					refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
					expiresAt: Date.now() + expiresIn * 1000
				},
				{
					providerUserId: parsed.userId,
					providerAccountId: OpenAIOAuthUtils.resolveWorkspace(parsed.authInfo),
					email: parsed.email
				},
				session.snapshot,
				session.reconnectId
			);
			AccountLoginSessions.finish(session, row.id);

			return { ok: true, email: row.email ?? undefined, accountId: row.id };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Login failed';
			AccountLoginSessions.finish(session, undefined, message);

			return { ok: false, error: message };
		}
	}

	public static getSession(sessionId: string) {
		return AccountLoginSessions.status(sessionId, 'openai');
	}

	public static async cancelLogin(sessionId: string): Promise<boolean> {
		const cancelled = AccountLoginSessions.cancel(sessionId, 'openai');
		if (this.listenerSession === sessionId) {
			this.listenerSession = null;
			await OpenAICallbackServer.stop();
		}

		return cancelled;
	}

	private static async exchangeRefresh(token: string) {
		const tokens = await OpenAIOAuthClient.refreshToken(token);
		if (!tokens || typeof tokens.access_token !== 'string') return null;

		return {
			accessToken: tokens.access_token,
			refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : token,
			expiresAt: Date.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000
		};
	}

	public static async getValidToken(accountId?: string): Promise<OAuthCredentials | null> {
		return AccountTokenService.get('openai', accountId, 60_000, (token) => this.exchangeRefresh(token));
	}

	public static async refreshAccountToken(accountId: string, expectedVersion?: number): Promise<OAuthCredentials | null> {
		return AccountTokenService.refresh('openai', accountId, (token) => this.exchangeRefresh(token), expectedVersion);
	}

	public static async refreshToken(refreshTokenValue: string): Promise<OAuthCredentials | null> {
		const row = OAuthAccounts.list('openai').find((account) => account.refreshToken === refreshTokenValue);

		return row ? this.refreshAccountToken(row.id, row.credentialVersion) : null;
	}

	public static getAuthStatus(): { authenticated: boolean; email?: string } {
		const row = OAuthAccounts.active('openai');

		return { authenticated: !!row && !row.needsLogin, email: row?.email ?? undefined };
	}

	public static logout(): void {
		const row = OAuthAccounts.active('openai');
		if (row) OAuthAccounts.remove('openai', row.id);
	}

	private static async handleCallbackRequest(
		requestUrl: string | undefined,
		path: string,
		response: ServerResponse
	): Promise<void> {
		const url = new URL(requestUrl ?? '/', config.openai.oauth.redirectUri);
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		if (url.pathname !== path) {
			response.statusCode = 404;
			response.end('Not found');

			return;
		}
		const sessionId = url.searchParams.get('state');
		const code = url.searchParams.get('code');
		if (!sessionId || sessionId !== this.listenerSession) {
			response.statusCode = 400;
			response.end('Invalid login session');

			return;
		}
		if (!code) {
			const session = AccountLoginSessions.get(sessionId, 'openai');
			const reason = url.searchParams.has('error') ? 'Provider denied authorization' : 'Missing authorization code';
			if (session) AccountLoginSessions.finish(session, undefined, reason);
		}
		const result: AccountLoginCompleteResponse = code ? await this.completeLogin(code, sessionId) : { ok: false };
		response.statusCode = result.ok ? 200 : 400;
		response.end(OpenAIOAuthUtils.callbackPage(result.ok, result.error));
		// Old callbacks cannot close a newer session's listener.
		if (this.listenerSession === sessionId) {
			this.listenerSession = null;
			await OpenAICallbackServer.stop();
		}
	}
}
