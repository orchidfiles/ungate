import { ProviderSettings } from '../database/provider-settings';

import type { AIProvider, AIProviderName } from './base-provider';

export class StaticTokenProvider implements AIProvider {
	readonly name: AIProviderName;

	public constructor(name: AIProviderName) {
		this.name = name;
	}

	getAuthHeader(): string | null {
		const creds = ProviderSettings.get(this.name);

		if (!creds?.accessToken) {
			return null;
		}

		return `Bearer ${creds.accessToken}`;
	}

	isAuthenticated(): boolean {
		const creds = ProviderSettings.get(this.name);

		return !!creds?.accessToken;
	}

	logout(): void {
		ProviderSettings.remove(this.name);
	}
}
