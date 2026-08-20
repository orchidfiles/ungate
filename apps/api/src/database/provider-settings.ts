import { eq } from 'drizzle-orm';

import { isModelMappingProvider } from '@ungate/shared';
import { logger } from 'src/utils/logger';

import { ProviderSecrets } from '../security/provider-secrets';

import { providerSettings } from './schema';

import { getDb } from './index';

import type { AIProviderName, OAuthCredentials } from '../auth/base-provider';

/** Everything about a provider that is safe to keep in SQLite. */
export interface ProviderMetadata {
	provider: string;
	expiresAt: number | null;
	email: string | null;
	accountId: string | null;
	createdAt: number;
	baseUrl: string | null;
}

/** Metadata joined with the credentials held by the extension. */
export interface ProviderCredentials extends ProviderMetadata {
	/** Empty when no credential is stored for an otherwise known provider. */
	accessToken: string;
	refreshToken: string | null;
}

/**
 * `access_token` / `refresh_token` are legacy columns. They are never written with a real
 * value anymore — {@link ProviderSettings.migrateLegacySecrets} moves pre-existing values
 * into the extension secret store and blanks them.
 */
const METADATA_COLUMNS = {
	provider: providerSettings.provider,
	expiresAt: providerSettings.expiresAt,
	email: providerSettings.email,
	accountId: providerSettings.accountId,
	createdAt: providerSettings.createdAt,
	baseUrl: providerSettings.baseUrl
};

const BLANK_LEGACY_SECRETS = { accessToken: '', refreshToken: null };

export class ProviderSettings {
	/** Non-secret fields only. Cheap: no round trip to the extension. */
	static getMetadata(provider: AIProviderName): ProviderMetadata | undefined {
		const db = getDb();

		return db.select(METADATA_COLUMNS).from(providerSettings).where(eq(providerSettings.provider, provider)).get();
	}

	static async get(provider: AIProviderName): Promise<ProviderCredentials | undefined> {
		const metadata = this.getMetadata(provider);

		if (!metadata) {
			return undefined;
		}

		const secret = await ProviderSecrets.read(provider);

		return {
			...metadata,
			accessToken: secret?.accessToken ?? '',
			refreshToken: secret?.refreshToken ?? null
		};
	}

	static async hasCredentials(provider: AIProviderName): Promise<boolean> {
		const credentials = await this.get(provider);

		return !!credentials?.accessToken;
	}

	static async upsertApiKey(provider: AIProviderName, accessToken: string, baseUrl?: string): Promise<void> {
		// Secret first: a metadata row without a credential is merely unauthenticated, while a
		// credential without a row is unreachable.
		await ProviderSecrets.write(provider, { accessToken, refreshToken: null });

		const db = getDb();

		db.insert(providerSettings)
			.values({
				provider,
				...BLANK_LEGACY_SECRETS,
				createdAt: Date.now(),
				...(baseUrl && { baseUrl })
			})
			.onConflictDoUpdate({
				target: providerSettings.provider,
				set: {
					...BLANK_LEGACY_SECRETS,
					...(baseUrl !== undefined && { baseUrl })
				}
			})
			.run();
	}

	static async upsertOAuth(provider: AIProviderName, data: OAuthCredentials): Promise<void> {
		await ProviderSecrets.write(provider, {
			accessToken: data.accessToken,
			refreshToken: data.refreshToken ?? null
		});

		const db = getDb();
		const metadata = {
			expiresAt: data.expiresAt,
			email: data.email ?? null,
			accountId: data.accountId ?? null
		};

		db.insert(providerSettings)
			.values({
				provider,
				...BLANK_LEGACY_SECRETS,
				...metadata,
				createdAt: Date.now()
			})
			.onConflictDoUpdate({
				target: providerSettings.provider,
				set: {
					...BLANK_LEGACY_SECRETS,
					...metadata
				}
			})
			.run();
	}

	static updateBaseUrl(provider: AIProviderName, baseUrl: string): boolean {
		const db = getDb();

		if (!this.getMetadata(provider)) {
			return false;
		}

		db.update(providerSettings).set({ baseUrl }).where(eq(providerSettings.provider, provider)).run();

		return true;
	}

	static async remove(provider: AIProviderName): Promise<void> {
		try {
			await ProviderSecrets.erase(provider);
		} finally {
			getDb().delete(providerSettings).where(eq(providerSettings.provider, provider)).run();
		}
	}

	/**
	 * Moves credentials written by older versions out of SQLite and blanks the columns. Runs
	 * once per database: after the first pass there is nothing left to move. Throws when the
	 * secret store is unreachable so that plaintext is never dropped without a safe copy.
	 */
	static async migrateLegacySecrets(): Promise<void> {
		const db = getDb();
		const legacyRows = db
			.select({
				provider: providerSettings.provider,
				accessToken: providerSettings.accessToken,
				refreshToken: providerSettings.refreshToken
			})
			.from(providerSettings)
			.all();

		for (const row of legacyRows) {
			const accessToken = row.accessToken ?? '';
			const refreshToken = row.refreshToken ?? '';

			if (!accessToken && !refreshToken) {
				continue;
			}

			if (isModelMappingProvider(row.provider)) {
				const stored = await ProviderSecrets.read(row.provider);

				// A credential written since the last restart is newer than the legacy column.
				if (!stored?.accessToken) {
					await ProviderSecrets.write(row.provider, { accessToken, refreshToken: refreshToken || null });
				}

				logger.log(`[secrets] moved legacy ${row.provider} credentials into the extension secret store`);
			} else {
				logger.error(`[secrets] scrubbed legacy credentials of unknown provider "${row.provider}"`);
			}

			db.update(providerSettings).set(BLANK_LEGACY_SECRETS).where(eq(providerSettings.provider, row.provider)).run();
		}
	}
}
