import { IpcSecretTransport, type SecretIpcHost } from './ipc-secret-transport';

/** Process surface the credential channel needs: IPC plus the ability to end the process. */
export interface CredentialChannelHost extends SecretIpcHost {
	exit(code?: number): never;
}

export class CredentialChannelMissingError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'CredentialChannelMissingError';
	}
}

/**
 * Claims the credential channel the extension owns. Provider credentials exist nowhere else,
 * so a process without the channel can serve no provider at all — start-up fails instead of
 * coming up half-usable. Losing the channel later is equally fatal: the process exits so the
 * leader window respawns it with a live channel instead of leaving an orphan on the port.
 */
export function requireCredentialChannel(host: CredentialChannelHost = process): IpcSecretTransport {
	const transport = IpcSecretTransport.install(host);

	if (!transport) {
		throw new CredentialChannelMissingError(
			'The API process was started without an IPC credential channel. Start Ungate from the extension.'
		);
	}

	// Registered after the transport, so in-flight requests reject before the process ends.
	host.on('disconnect', () => {
		host.exit(0);
	});

	return transport;
}
