import { config, geminiOAuthClient } from 'src/config';
import { logger } from 'src/utils/logger';

import { AccountRefreshRejected } from '../account-token-service';

/** OAuth credentials must be supplied as a complete valid pair in the environment. */
export class GeminiOAuthNotConfiguredError extends Error {
	constructor() {
		super(
			'Gemini sign-in is not configured: set UNGATE_GEMINI_OAUTH_CLIENT_ID (ending in .apps.googleusercontent.com) and UNGATE_GEMINI_OAUTH_CLIENT_SECRET'
		);
	}
}

export function requireGeminiOAuthClient(): { clientId: string; clientSecret: string } {
	const credentials = geminiOAuthClient();
	if (!credentials) throw new GeminiOAuthNotConfiguredError();

	return credentials;
}

export interface GoogleUserInfo {
	id: string | null;
	email: string | null;
}

/** Google OAuth token endpoint and userinfo. The installed-app flow needs the client secret on every call. */
export class GeminiOAuthClient {
	public static async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<Record<string, unknown>> {
		const oauthConfig = config.gemini.oauth;
		const credentials = requireGeminiOAuthClient();
		let response: Response;
		try {
			response = await fetch(oauthConfig.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: credentials.clientId,
					client_secret: credentials.clientSecret,
					code,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier
				})
			});
		} catch (error) {
			logger.error('Gemini token exchange request failed:', error);
			const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
			throw new Error(
				`Could not reach oauth2.googleapis.com${cause ? ` (${cause})` : ''}. Check your connection and sign in again.`
			);
		}

		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const reason = (body as { error_description?: unknown } | null)?.error_description;
			logger.error('Gemini token exchange failed:', response.status, body);
			throw new Error(`Google rejected the sign-in (${response.status})${typeof reason === 'string' ? `: ${reason}` : ''}`);
		}

		return (body ?? {}) as Record<string, unknown>;
	}

	public static async refreshToken(refreshTokenValue: string): Promise<Record<string, unknown> | null> {
		const oauthConfig = config.gemini.oauth;
		// A missing client is a local setup problem, not a revoked grant: keep the account signed in.
		const credentials = geminiOAuthClient();
		if (!credentials) {
			logger.error(new GeminiOAuthNotConfiguredError().message);

			return null;
		}

		try {
			const response = await fetch(oauthConfig.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: credentials.clientId,
					client_secret: credentials.clientSecret,
					refresh_token: refreshTokenValue
				})
			});

			if (!response.ok) {
				const body: { error?: string } | null = await response.json().catch(() => null);
				if (response.status === 401 || body?.error === 'invalid_grant') throw new AccountRefreshRejected('Refresh rejected');
				logger.error('Gemini token refresh failed:', response.status);

				return null;
			}

			const body: unknown = await response.json();

			return body as Record<string, unknown>;
		} catch (error) {
			if (error instanceof AccountRefreshRejected) throw error;
			logger.error('Failed to refresh Gemini token');

			return null;
		}
	}

	public static async userInfo(accessToken: string): Promise<GoogleUserInfo> {
		const response = await fetch(config.gemini.oauth.userInfoUrl, {
			headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
		});
		if (!response.ok) throw new Error(`Google userinfo failed (${response.status})`);
		const json: unknown = await response.json();
		const body = (json ?? {}) as { id?: unknown; email?: unknown };

		return {
			id: typeof body.id === 'string' ? body.id : null,
			email: typeof body.email === 'string' ? body.email : null
		};
	}
}
