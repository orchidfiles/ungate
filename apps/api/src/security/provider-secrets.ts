import { logger } from 'src/utils/logger';

import type { AIProviderName } from '../auth/base-provider';
import type { ProviderSecret } from '@ungate/shared';

/**
 * Raised when provider credentials cannot be reached at all — no IPC channel, a closed
 * channel, or a channel that stopped answering. Writes must fail loudly rather than fall
 * back to the database, which no longer stores credentials.
 */
export class SecretStorageUnavailableError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'SecretStorageUnavailableError';
	}
}

/** Credential store owned by the extension host. The API process only ever talks to a transport. */
export interface ProviderSecretTransport {
	read(provider: AIProviderName): Promise<ProviderSecret | null>;
	write(provider: AIProviderName, secret: ProviderSecret): Promise<void>;
	erase(provider: AIProviderName): Promise<void>;
}

let activeTransport: ProviderSecretTransport | null = null;

/** Installs (or clears, with `null`) the process-wide credential transport. */
export function useProviderSecretTransport(transport: ProviderSecretTransport | null): void {
	activeTransport = transport;
}

export class ProviderSecrets {
	/**
	 * Reads deny by default: without a working channel the provider counts as unauthenticated
	 * instead of falling back to any other source. Failures are logged by provider name only.
	 */
	static async read(provider: AIProviderName): Promise<ProviderSecret | null> {
		if (!activeTransport) {
			logger.error(`[secrets] no credential channel available, treating ${provider} as unauthenticated`);

			return null;
		}

		try {
			return await activeTransport.read(provider);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			logger.error(`[secrets] failed to read ${provider} credentials: ${message}`);

			return null;
		}
	}

	static async write(provider: AIProviderName, secret: ProviderSecret): Promise<void> {
		if (!activeTransport) {
			throw new SecretStorageUnavailableError(
				`Cannot store ${provider} credentials: the extension credential channel is unavailable.`
			);
		}

		await activeTransport.write(provider, secret);
	}

	static async erase(provider: AIProviderName): Promise<void> {
		if (!activeTransport) {
			throw new SecretStorageUnavailableError(
				`Cannot delete ${provider} credentials: the extension credential channel is unavailable.`
			);
		}

		await activeTransport.erase(provider);
	}
}
