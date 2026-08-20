import { randomUUID } from 'node:crypto';

import {
	PROVIDER_SECRET_CHANNEL,
	parseProviderSecretResponse,
	readProviderSecretEnvelope,
	type ProviderSecret,
	type ProviderSecretAction,
	type ProviderSecretRequest
} from '@ungate/shared';
import { logger } from 'src/utils/logger';

import { SecretStorageUnavailableError, useProviderSecretTransport, type ProviderSecretTransport } from './provider-secrets';

import type { AIProviderName } from '../auth/base-provider';

/** The extension answers from VS Code SecretStorage, which is local; a slow answer means it is gone. */
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
	resolve(secret: ProviderSecret | null): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/** Slice of `process` the transport drives. Method syntax keeps `process` assignable. */
export interface SecretIpcHost {
	send?(message: unknown): boolean;
	on(event: string, listener: (payload: unknown) => void): unknown;
}

/**
 * Request/response client for the extension-owned credential store, riding the IPC channel
 * of the child process. Every inbound message is validated and correlated by request id;
 * unknown ids, malformed payloads and channel loss all fail closed.
 */
export class IpcSecretTransport implements ProviderSecretTransport {
	private readonly pending = new Map<string, PendingRequest>();
	private connected = true;

	private constructor(private readonly host: SecretIpcHost) {
		this.host.on('message', (message) => {
			this.onMessage(message);
		});
		this.host.on('disconnect', () => {
			this.onDisconnect();
		});
	}

	/** Installs the transport when the process owns an IPC channel, returns null when it does not. */
	static install(host: SecretIpcHost = process): IpcSecretTransport | null {
		if (typeof host.send !== 'function') {
			return null;
		}

		const transport = new IpcSecretTransport(host);

		useProviderSecretTransport(transport);

		return transport;
	}

	async read(provider: AIProviderName): Promise<ProviderSecret | null> {
		return this.request('get', provider);
	}

	async write(provider: AIProviderName, secret: ProviderSecret): Promise<void> {
		await this.request('set', provider, secret);
	}

	async erase(provider: AIProviderName): Promise<void> {
		await this.request('delete', provider);
	}

	private request(
		action: ProviderSecretAction,
		provider: AIProviderName,
		secret?: ProviderSecret
	): Promise<ProviderSecret | null> {
		const send = this.host.send?.bind(this.host);

		if (!this.connected || typeof send !== 'function') {
			return Promise.reject(
				new SecretStorageUnavailableError('The extension credential channel is closed; restart the API from the dashboard.')
			);
		}

		const id = randomUUID();
		const message: ProviderSecretRequest = {
			channel: PROVIDER_SECRET_CHANNEL,
			id,
			action,
			provider,
			...(secret && { secret })
		};

		return new Promise<ProviderSecret | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new SecretStorageUnavailableError(`The extension did not answer a credential ${action} within ${REQUEST_TIMEOUT_MS}ms.`)
				);
			}, REQUEST_TIMEOUT_MS);

			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });

			try {
				// A `false` return only means the channel backlog is full; the message stays queued.
				send(message);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(
					new SecretStorageUnavailableError(
						`Failed to reach the extension credential store: ${error instanceof Error ? error.message : String(error)}`
					)
				);
			}
		});
	}

	private onMessage(message: unknown): void {
		const envelope = readProviderSecretEnvelope(message);

		if (!envelope) {
			return;
		}

		const pending = this.pending.get(envelope.id);

		if (!pending) {
			logger.error('[secrets] discarded a credential response with an unknown request id');

			return;
		}

		this.pending.delete(envelope.id);
		clearTimeout(pending.timer);

		const response = parseProviderSecretResponse(message);

		if (!response) {
			pending.reject(new SecretStorageUnavailableError('The extension sent a malformed credential response.'));

			return;
		}

		if (!response.ok) {
			pending.reject(new Error(`The extension refused the credential request: ${response.error}`));

			return;
		}

		pending.resolve(response.secret);
	}

	private onDisconnect(): void {
		this.connected = false;

		const abandoned = [...this.pending.values()];

		this.pending.clear();

		for (const request of abandoned) {
			clearTimeout(request.timer);
			request.reject(new SecretStorageUnavailableError('The extension closed the credential channel.'));
		}

		if (abandoned.length > 0) {
			logger.error(`[secrets] credential channel closed with ${abandoned.length} request(s) in flight`);
		}
	}
}
