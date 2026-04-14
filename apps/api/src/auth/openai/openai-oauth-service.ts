import { randomBytes } from 'node:crypto';

import { config } from 'src/config';
import { ProviderSettings } from 'src/database/provider-settings';
import { logger } from 'src/utils/logger';

import { OpenAICallbackServer } from './callback-server';
import { OpenAIOAuthClient } from './oauth-client';
import { OpenAIOAuthUtils } from './openai-oauth-utils';
import { OpenAIPkceSessionStore } from './pkce-session-store';

import type { OAuthCredentials } from '../base-provider';
import type { ServerResponse } from 'node:http';

export class OpenAIOAuthService {
	static {
		OpenAIPkceSessionStore.startCleanup();
	}

	public static async startLogin(): Promise<{ authUrl: string; sessionId: string }> {
		const { verifier, challenge } = await OpenAIOAuthUtils.generatePkce();
		const sessionId = OpenAIOAuthUtils.base64urlEncode(randomBytes(32));
		const oauthConfig = config.openai.oauth;
		const redirectUri = oauthConfig.redirectUri;

		OpenAIPkceSessionStore.set(sessionId, {
			codeVerifier: verifier,
			state: verifier,
			expiresAt: Date.now() + 10 * 60 * 1000
		});

		await OpenAICallbackServer.start((requestUrl, path, response) => this.handleCallbackRequest(requestUrl, path, response));
		const params = new URLSearchParams({
			response_type: 'code',
			client_id: oauthConfig.clientId,
			redirect_uri: redirectUri,
			scope: oauthConfig.scope,
			code_challenge: challenge,
			code_challenge_method: oauthConfig.codeChallengeMethod,
			...oauthConfig.extraParams,
			state: sessionId
		});

		return { authUrl: `${oauthConfig.authorizeUrl}?${params}`, sessionId };
	}

	public static async completeLogin(code: string, sessionId: string): Promise<{ ok: boolean; email?: string; error?: string }> {
		const session = OpenAIPkceSessionStore.get(sessionId);

		if (!session) {
			return { ok: false, error: 'Session not found or expired' };
		}

		if (Date.now() >= session.expiresAt) {
			OpenAIPkceSessionStore.delete(sessionId);

			return { ok: false, error: 'Session expired' };
		}

		OpenAIPkceSessionStore.delete(sessionId);
		const tokens = await OpenAIOAuthClient.exchangeCode(code, session.codeVerifier);

		if (!tokens) {
			return { ok: false, error: 'Token exchange failed' };
		}

		const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : null;
		let email: string | null = null;
		let accountId: string | null = null;

		if (idToken) {
			const parsed = OpenAIOAuthUtils.parseIdToken(idToken);
			email = parsed.email;
			accountId = OpenAIOAuthUtils.resolveWorkspace(parsed.authInfo);
		}

		const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
		const credentials: OAuthCredentials = {
			accessToken: tokens.access_token as string,
			refreshToken: (tokens.refresh_token as string) || '',
			expiresAt: Date.now() + expiresIn * 1000,
			email: email ?? undefined,
			accountId: accountId ?? undefined
		};

		ProviderSettings.upsertOAuth('openai', credentials);
		logger.log('✓ OpenAI OAuth login complete', email ? `(${email})` : '');

		return { ok: true, email: email ?? undefined };
	}

	public static async getValidToken(): Promise<OAuthCredentials | null> {
		const credentials = ProviderSettings.get('openai');

		if (!credentials) {
			return null;
		}

		const bufferMs = 60_000;

		if (Date.now() < (credentials.expiresAt ?? 0) - bufferMs) {
			return credentials;
		}

		return this.refreshToken(credentials.refreshToken ?? '');
	}

	public static async refreshToken(refreshTokenValue: string): Promise<OAuthCredentials | null> {
		logger.log('Refreshing OpenAI token...');
		const tokens = await OpenAIOAuthClient.refreshToken(refreshTokenValue);

		if (!tokens) {
			return null;
		}

		const existingCredentials = ProviderSettings.get('openai');
		const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
		const credentials: OAuthCredentials = {
			accessToken: tokens.access_token as string,
			refreshToken: (tokens.refresh_token as string | null) ?? refreshTokenValue,
			expiresAt: Date.now() + expiresIn * 1000,
			email: existingCredentials?.email ?? undefined,
			accountId: existingCredentials?.accountId ?? undefined
		};

		ProviderSettings.upsertOAuth('openai', credentials);
		logger.log('OpenAI token refreshed successfully');

		return credentials;
	}

	public static getAuthStatus(): { authenticated: boolean; email?: string } {
		const credentials = ProviderSettings.get('openai');

		return {
			authenticated: !!credentials?.accessToken,
			email: credentials?.email ?? undefined
		};
	}

	public static logout(): void {
		ProviderSettings.remove('openai');
		logger.log('✓ OpenAI OAuth logged out, tokens deleted');
	}

	private static async handleCallbackRequest(
		requestUrl: string | undefined,
		path: string,
		response: ServerResponse
	): Promise<void> {
		if (!requestUrl) {
			response.statusCode = 400;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('<html><body><h1>Missing request URL</h1></body></html>');

			return;
		}

		const url = new URL(requestUrl, config.openai.oauth.redirectUri);

		if (url.pathname !== path) {
			response.statusCode = 404;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('<html><body><h1>Not found</h1></body></html>');

			return;
		}

		const code = url.searchParams.get('code');
		const sessionId = url.searchParams.get('state');

		if (!code || !sessionId) {
			response.statusCode = 400;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('<html><body><h1>Missing code or session</h1><p>Please close this window and try again.</p></body></html>');

			return;
		}

		const result = await this.completeLogin(code, sessionId);
		response.setHeader('Content-Type', 'text/html; charset=utf-8');

		if (result.ok) {
			response.end(
				'<html><body><h1>Connected!</h1><p>You can close this window.</p><script>window.close()</script></body></html>'
			);
		} else {
			response.statusCode = 400;
			response.end(`<html><body><h1>Error</h1><p>${result.error ?? 'Unknown error'}</p></body></html>`);
		}

		await OpenAICallbackServer.stop();
	}
}
