import { config } from 'src/config';
import { logger } from 'src/utils/logger';

export class OpenAIOAuthClient {
	public static async exchangeCode(code: string, codeVerifier: string): Promise<Record<string, unknown> | null> {
		const oauthConfig = config.openai.oauth;
		const redirectUri = oauthConfig.redirectUri;

		try {
			const response = await fetch(oauthConfig.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: oauthConfig.clientId,
					code,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token exchange failed:', response.status, errorText);

				return null;
			}

			const parsedTokens = await response.json();
			const tokens = parsedTokens as Record<string, unknown>;

			return tokens;
		} catch (error) {
			logger.error('exchangeCodeForTokens error:', error);

			return null;
		}
	}

	public static async refreshToken(refreshTokenValue: string): Promise<Record<string, unknown> | null> {
		const oauthConfig = config.openai.oauth;

		try {
			const response = await fetch(oauthConfig.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: oauthConfig.clientId,
					refresh_token: refreshTokenValue
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token refresh failed:', response.status, errorText);

				return null;
			}

			const parsedTokens = await response.json();
			const tokens = parsedTokens as Record<string, unknown>;

			return tokens;
		} catch (error) {
			logger.error('Failed to refresh token:', error);

			return null;
		}
	}
}
