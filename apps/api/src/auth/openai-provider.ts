import { OpenAIOAuthService } from './openai/openai-oauth-service';

import type { AIProvider } from './base-provider';

export class OpenAIProvider implements AIProvider {
	readonly name = 'openai' as const;

	async getAuthHeader(): Promise<string | null> {
		const token = await OpenAIOAuthService.getValidToken();

		return token ? `Bearer ${token.accessToken}` : null;
	}

	isAuthenticated(): boolean {
		return OpenAIOAuthService.getAuthStatus().authenticated;
	}

	logout(): void {
		OpenAIOAuthService.logout();
	}
}
