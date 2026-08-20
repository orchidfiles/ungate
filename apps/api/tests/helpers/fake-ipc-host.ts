import type { CredentialChannelHost } from 'src/security/credential-channel';
import type { ProviderSecretRequest } from '@ungate/shared';

/** Stands in for the IPC channel the extension host owns. */
export class FakeIpcHost implements CredentialChannelHost {
	readonly sent: ProviderSecretRequest[] = [];
	exitCode: number | null = null;
	private readonly listeners: Record<string, ((payload: unknown) => void)[]> = {};

	send(message: unknown): boolean {
		this.sent.push(message as ProviderSecretRequest);

		return true;
	}

	on(event: string, listener: (payload: unknown) => void): this {
		this.listeners[event] ??= [];
		this.listeners[event].push(listener);

		return this;
	}

	/** Records the exit instead of ending the test worker; execution continues past the call. */
	exit(code?: number): never {
		this.exitCode = code ?? 0;

		return undefined as never;
	}

	emit(event: string, payload?: unknown): void {
		for (const listener of this.listeners[event] ?? []) {
			listener(payload);
		}
	}

	listenerCount(event: string): number {
		return this.listeners[event]?.length ?? 0;
	}

	lastRequest(): ProviderSecretRequest {
		const request = this.sent.at(-1);

		if (!request) {
			throw new Error('No credential request was sent.');
		}

		return request;
	}
}

/** A host that was started without an IPC channel: no `send`, so nothing can be installed. */
export function createHostWithoutIpc(): FakeIpcHost {
	const host = new FakeIpcHost();

	// `send` is the only signal Node gives that an IPC channel exists.
	Object.defineProperty(host, 'send', { value: undefined, configurable: true });

	return host;
}
