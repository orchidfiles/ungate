import { OAuth } from './oauth';

import type { AIProvider } from './base-provider';

export class ClaudeProvider implements AIProvider {
	readonly name = 'claude' as const;

	async getAuthHeader(): Promise<string | null> {
		const token = await OAuth.getValidToken();

		if (!token) {
			return null;
		}

		return `Bearer ${token.accessToken}`;
	}

	async isAuthenticated(): Promise<boolean> {
		const status = await OAuth.getAuthStatus();

		return status.authenticated;
	}

	async logout(): Promise<void> {
		await OAuth.logout();
	}
}
