import { eq } from 'drizzle-orm';

import { providerSettings } from './schema';

import { getDb } from './index';

import type { AIProviderName, OAuthCredentials } from '../auth/base-provider';

export class ProviderSettings {
	static get(provider: AIProviderName) {
		const db = getDb();

		return db.select().from(providerSettings).where(eq(providerSettings.provider, provider)).get();
	}

	static upsertApiKey(provider: AIProviderName, accessToken: string, baseUrl?: string): void {
		const db = getDb();

		db.insert(providerSettings)
			.values({
				provider,
				accessToken,
				createdAt: Date.now(),
				...(baseUrl && { baseUrl })
			})
			.onConflictDoUpdate({
				target: providerSettings.provider,
				set: {
					accessToken,
					...(baseUrl !== undefined && { baseUrl })
				}
			})
			.run();
	}

	static upsertOAuth(provider: AIProviderName, data: OAuthCredentials): void {
		const db = getDb();

		db.insert(providerSettings)
			.values({
				provider,
				accessToken: data.accessToken,
				refreshToken: data.refreshToken,
				expiresAt: data.expiresAt,
				email: data.email ?? null,
				accountId: data.accountId ?? null,
				createdAt: Date.now()
			})
			.onConflictDoUpdate({
				target: providerSettings.provider,
				set: {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
					expiresAt: data.expiresAt,
					email: data.email ?? null,
					accountId: data.accountId ?? null
				}
			})
			.run();
	}

	static updateBaseUrl(provider: AIProviderName, baseUrl: string): boolean {
		const db = getDb();
		const existing = this.get(provider);

		if (!existing) {
			return false;
		}

		db.update(providerSettings).set({ baseUrl }).where(eq(providerSettings.provider, provider)).run();

		return true;
	}

	static remove(provider: AIProviderName): void {
		const db = getDb();

		db.delete(providerSettings).where(eq(providerSettings.provider, provider)).run();
	}
}
