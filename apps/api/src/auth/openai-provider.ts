import { ProviderSettings } from '../database/provider-settings';

import type { AIProvider } from './base-provider';

export class OpenAIProvider implements AIProvider {
	readonly name = 'openai' as const;

	getAuthHeader(): string | null {
		const creds = ProviderSettings.get('openai');

		if (!creds?.accessToken) {
			return null;
		}

		return `Bearer ${creds.accessToken}`;
	}

	isAuthenticated(): boolean {
		const creds = ProviderSettings.get('openai');

		return !!creds?.accessToken;
	}

	logout(): void {
		ProviderSettings.remove('openai');
	}
}
