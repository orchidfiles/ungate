import { useProviderSecretTransport, type ProviderSecretTransport } from 'src/security/provider-secrets';

import type { AIProviderName } from 'src/auth/base-provider';
import type { ProviderSecret } from '@ungate/shared';

/** Stands in for the extension-owned VS Code SecretStorage during tests. */
export class MemorySecretTransport implements ProviderSecretTransport {
	private readonly secrets = new Map<AIProviderName, ProviderSecret>();

	async read(provider: AIProviderName): Promise<ProviderSecret | null> {
		return this.secrets.get(provider) ?? null;
	}

	async write(provider: AIProviderName, secret: ProviderSecret): Promise<void> {
		this.secrets.set(provider, { ...secret });
	}

	async erase(provider: AIProviderName): Promise<void> {
		this.secrets.delete(provider);
	}

	/** Direct view for assertions that must not go through the production read path. */
	peek(provider: AIProviderName): ProviderSecret | undefined {
		return this.secrets.get(provider);
	}

	clear(): void {
		this.secrets.clear();
	}
}

/** Installs a fresh in-memory credential store and returns it. */
export function useMemorySecretTransport(): MemorySecretTransport {
	const transport = new MemorySecretTransport();

	useProviderSecretTransport(transport);

	return transport;
}
