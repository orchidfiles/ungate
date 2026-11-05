import { config } from 'src/config';
import { logger } from 'src/utils/logger';

export class OpenAIOAuthClient {
	public static async exchangeCode(code: string, codeVerifier: string): Promise<Record<string, unknown>> {
		const oauthConfig = config.openai.oauth;
		let response: Response;
		try {
			response = await fetch(oauthConfig.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: oauthConfig.clientId,
					code,
					redirect_uri: oauthConfig.redirectUri,
					code_verifier: codeVerifier
				})
			});
		} catch (error) {
			logger.error('Token exchange request failed:', error);
			const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code : undefined;
			const host = new URL(oauthConfig.tokenUrl).host;
			throw new Error(`Could not reach ${host}${cause ? ` (${cause})` : ''}. Check your connection and sign in again.`);
		}

		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const reason = (body as { error?: { message?: unknown } } | null)?.error?.message;
			logger.error('Token exchange failed:', response.status, body);
			throw new Error(`OpenAI rejected the sign-in (${response.status})${typeof reason === 'string' ? `: ${reason}` : ''}`);
		}

		return (body ?? {}) as Record<string, unknown>;
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
