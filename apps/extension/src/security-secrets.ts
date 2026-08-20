import { randomBytes } from 'node:crypto';

import {
	ADMIN_KEY_MIN_LENGTH,
	ADMIN_KEY_SECRET_KEY,
	PROVIDER_SECRET_CHANNEL,
	isProviderSecret,
	parseProviderSecretRequest,
	providerSecretKey,
	readProviderSecretEnvelope,
	type ModelMappingProvider,
	type ProviderSecret,
	type ProviderSecretResponse
} from '@ungate/shared';

/**
 * The slice of `vscode.SecretStorage` this module needs. Narrowing it keeps the credential
 * logic independent of the `vscode` module so it can be driven directly.
 */
export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

/**
 * Owner of every Ungate secret: the administrative API key that gates administrative HTTP
 * routes, and the provider credentials the API child process asks for over IPC. Nothing here
 * is written to SQLite, the runtime state file, or the log.
 */
export class SecuritySecrets {
	private constructor(
		private readonly storage: SecretStore,
		public readonly adminApiKey: string
	) {}

	/** Loads the administrative key, minting a 256-bit one on first run or if the stored key is unusable. */
	static async create(storage: SecretStore): Promise<SecuritySecrets> {
		const stored = await storage.get(ADMIN_KEY_SECRET_KEY);

		if (stored && stored.length >= ADMIN_KEY_MIN_LENGTH) {
			return new SecuritySecrets(storage, stored);
		}

		const minted = randomBytes(32).toString('base64url');

		await storage.store(ADMIN_KEY_SECRET_KEY, minted);

		return new SecuritySecrets(storage, minted);
	}

	/**
	 * Answers one IPC message from the API child. Returns the response to send back, or null
	 * when the message does not belong to the credential channel. Errors are reported by
	 * provider and action only — never with a credential value.
	 */
	async handleApiChildMessage(message: unknown): Promise<ProviderSecretResponse | null> {
		const envelope = readProviderSecretEnvelope(message);

		if (!envelope) {
			return null;
		}

		const request = parseProviderSecretRequest(message);

		if (!request) {
			return { channel: PROVIDER_SECRET_CHANNEL, id: envelope.id, ok: false, error: 'Malformed credential request' };
		}

		try {
			if (request.action === 'get') {
				return {
					channel: PROVIDER_SECRET_CHANNEL,
					id: request.id,
					ok: true,
					secret: await this.readProviderSecret(request.provider)
				};
			}

			if (request.action === 'set') {
				await this.storage.store(providerSecretKey(request.provider), JSON.stringify(request.secret));
			} else {
				await this.storage.delete(providerSecretKey(request.provider));
			}

			return { channel: PROVIDER_SECRET_CHANNEL, id: request.id, ok: true, secret: null };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);

			return {
				channel: PROVIDER_SECRET_CHANNEL,
				id: request.id,
				ok: false,
				error: `Secret storage rejected ${request.action} for ${request.provider}: ${reason}`
			};
		}
	}

	private async readProviderSecret(provider: ModelMappingProvider): Promise<ProviderSecret | null> {
		const raw = await this.storage.get(providerSecretKey(provider));

		if (!raw) {
			return null;
		}

		let parsed: unknown;

		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}

		if (!isProviderSecret(parsed)) {
			return null;
		}

		return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
	}
}
