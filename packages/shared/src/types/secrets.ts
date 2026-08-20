import { isModelMappingProvider } from '../guards/settings';

import type { ModelMappingProvider } from './settings';

/** VS Code SecretStorage key holding the administrative API key the extension mints per install. */
export const ADMIN_KEY_SECRET_KEY = 'ungate.admin-api-key';

/** Prefix of the VS Code SecretStorage keys holding per-provider credentials. */
export const PROVIDER_SECRET_KEY_PREFIX = 'ungate.provider.';

/**
 * Discriminator carried by every message on the API child IPC channel. Both sides drop
 * messages without it, so the channel can be shared with unrelated traffic.
 */
export const PROVIDER_SECRET_CHANNEL = 'ungate.provider-secret';

export const PROVIDER_SECRET_ACTIONS = ['get', 'set', 'delete'] as const;

export type ProviderSecretAction = (typeof PROVIDER_SECRET_ACTIONS)[number];

/** The only credential fields that must never be written to SQLite. */
export interface ProviderSecret {
	accessToken: string;
	refreshToken: string | null;
}

export interface ProviderSecretRequest {
	channel: typeof PROVIDER_SECRET_CHANNEL;
	id: string;
	action: ProviderSecretAction;
	provider: ModelMappingProvider;
	/** Present exactly for `set`. */
	secret?: ProviderSecret;
}

export type ProviderSecretResponse =
	| { channel: typeof PROVIDER_SECRET_CHANNEL; id: string; ok: true; secret: ProviderSecret | null }
	| { channel: typeof PROVIDER_SECRET_CHANNEL; id: string; ok: false; error: string };

export function providerSecretKey(provider: ModelMappingProvider): string {
	return `${PROVIDER_SECRET_KEY_PREFIX}${provider}`;
}

export function isProviderSecretAction(value: unknown): value is ProviderSecretAction {
	return typeof value === 'string' && PROVIDER_SECRET_ACTIONS.includes(value as ProviderSecretAction);
}

export function isProviderSecret(value: unknown): value is ProviderSecret {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as { accessToken?: unknown; refreshToken?: unknown };

	if (typeof candidate.accessToken !== 'string') {
		return false;
	}

	return candidate.refreshToken === null || typeof candidate.refreshToken === 'string';
}

/**
 * Recognizes a message as belonging to the secret channel without trusting its payload.
 * The correlation id is needed to answer malformed requests instead of leaving the
 * sender waiting for a reply that never comes.
 */
export function readProviderSecretEnvelope(value: unknown): { id: string } | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}

	const candidate = value as { channel?: unknown; id?: unknown };

	if (candidate.channel !== PROVIDER_SECRET_CHANNEL) {
		return null;
	}

	if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
		return null;
	}

	return { id: candidate.id };
}

export function parseProviderSecretRequest(value: unknown): ProviderSecretRequest | null {
	const envelope = readProviderSecretEnvelope(value);

	if (!envelope) {
		return null;
	}

	const candidate = value as { action?: unknown; provider?: unknown; secret?: unknown };

	if (!isProviderSecretAction(candidate.action) || !isModelMappingProvider(candidate.provider)) {
		return null;
	}

	if (candidate.action === 'set') {
		if (!isProviderSecret(candidate.secret)) {
			return null;
		}

		return {
			channel: PROVIDER_SECRET_CHANNEL,
			id: envelope.id,
			action: 'set',
			provider: candidate.provider,
			secret: { accessToken: candidate.secret.accessToken, refreshToken: candidate.secret.refreshToken }
		};
	}

	if (candidate.secret !== undefined) {
		return null;
	}

	return {
		channel: PROVIDER_SECRET_CHANNEL,
		id: envelope.id,
		action: candidate.action,
		provider: candidate.provider
	};
}

export function parseProviderSecretResponse(value: unknown): ProviderSecretResponse | null {
	const envelope = readProviderSecretEnvelope(value);

	if (!envelope) {
		return null;
	}

	const candidate = value as { ok?: unknown; secret?: unknown; error?: unknown };

	if (candidate.ok === true) {
		if (candidate.secret !== null && !isProviderSecret(candidate.secret)) {
			return null;
		}

		return {
			channel: PROVIDER_SECRET_CHANNEL,
			id: envelope.id,
			ok: true,
			secret: candidate.secret ?? null
		};
	}

	if (candidate.ok === false && typeof candidate.error === 'string') {
		return { channel: PROVIDER_SECRET_CHANNEL, id: envelope.id, ok: false, error: candidate.error };
	}

	return null;
}
