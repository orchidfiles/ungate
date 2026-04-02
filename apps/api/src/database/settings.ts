import { eq } from 'drizzle-orm';

import { appSettings, providerSettings } from './schema';

import { getDb } from './index';

import type { AIProviderName, OAuthCredentials } from '../auth/base-provider';
import type { AppSettings } from '@ungate/shared';

export class Settings {
	private static generateApiKey(): string {
		return crypto.randomUUID().replace(/-/g, '').slice(0, 15);
	}

	static get(): AppSettings {
		const db = getDb();
		let row = db.select().from(appSettings).where(eq(appSettings.id, 1)).get();

		if (!row) {
			[row] = db.insert(appSettings).values({ id: 1, apiKey: this.generateApiKey() }).returning().all();
		}

		return {
			port: row.port,
			apiKey: row.apiKey,
			quiet: row.quiet,
			extraInstruction: row.extraInstruction
		};
	}

	static update(settings: Partial<AppSettings>): void {
		const db = getDb();

		db.insert(appSettings)
			.values({ id: 1 })
			.onConflictDoUpdate({
				target: appSettings.id,
				set: {
					...(settings.port !== undefined && { port: settings.port }),
					...(settings.apiKey !== undefined && { apiKey: settings.apiKey }),
					...(settings.quiet !== undefined && { quiet: settings.quiet }),
					...(settings.extraInstruction !== undefined && { extraInstruction: settings.extraInstruction })
				}
			})
			.run();
	}
}

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

	static upsertOAuth(provider: 'claude', data: OAuthCredentials): void {
		const db = getDb();

		db.insert(providerSettings)
			.values({
				provider,
				accessToken: data.accessToken,
				refreshToken: data.refreshToken,
				expiresAt: data.expiresAt,
				email: data.email ?? null,
				createdAt: Date.now()
			})
			.onConflictDoUpdate({
				target: providerSettings.provider,
				set: {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
					expiresAt: data.expiresAt,
					email: data.email ?? null
				}
			})
			.run();
	}

	static remove(provider: AIProviderName): void {
		const db = getDb();

		db.delete(providerSettings).where(eq(providerSettings.provider, provider)).run();
	}
}
