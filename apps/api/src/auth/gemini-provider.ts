import { GeminiOAuthService } from './gemini/gemini-oauth-service';

import type { AIProvider } from './base-provider';

export class GeminiProvider implements AIProvider {
	readonly name = 'gemini' as const;

	async getAuthHeader(): Promise<string | null> {
		const token = await GeminiOAuthService.getValidToken();

		return token ? `Bearer ${token.accessToken}` : null;
	}

	isAuthenticated(): boolean {
		return GeminiOAuthService.getAuthStatus().authenticated;
	}

	logout(): void {
		GeminiOAuthService.logout();
	}
}
