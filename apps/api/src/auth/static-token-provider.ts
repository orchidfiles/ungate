import { ProviderSettings } from '../database/provider-settings';

import type { AIProvider, AIProviderName } from './base-provider';

export class StaticTokenProvider implements AIProvider {
	readonly name: AIProviderName;

	public constructor(name: AIProviderName) {
		this.name = name;
	}

	async getAuthHeader(): Promise<string | null> {
		const creds = await ProviderSettings.get(this.name);

		if (!creds?.accessToken) {
			return null;
		}

		return `Bearer ${creds.accessToken}`;
	}

	async isAuthenticated(): Promise<boolean> {
		return ProviderSettings.hasCredentials(this.name);
	}

	async logout(): Promise<void> {
		await ProviderSettings.remove(this.name);
	}
}
