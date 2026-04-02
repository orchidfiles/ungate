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

	isAuthenticated(): boolean {
		return OAuth.getAuthStatus().authenticated;
	}

	logout(): void {
		OAuth.logout();
	}
}
