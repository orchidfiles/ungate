import { ProviderSettings } from '../database/provider-settings';

import type { AIProvider } from './base-provider';

export class MiniMaxProvider implements AIProvider {
	readonly name = 'minimax' as const;

	getAuthHeader(): string | null {
		const creds = ProviderSettings.get('minimax');

		if (!creds?.accessToken) {
			return null;
		}

		return `Bearer ${creds.accessToken}`;
	}

	isAuthenticated(): boolean {
		const creds = ProviderSettings.get('minimax');

		return !!creds?.accessToken;
	}

	logout(): void {
		ProviderSettings.remove('minimax');
	}
}
