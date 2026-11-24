import { NgrokAuthToken } from '@ungate/shared';

const SECRET_KEY = 'ungate.ngrokAuthToken';

/** SecretStorage view the token store needs. Tests pass a fake; production passes `ExtensionContext.secrets`. */
export interface NgrokSecretStorage {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
}

/** Secret storage for a TunnelManager built without an extension context: holds nothing. */
export class UnavailableNgrokSecrets implements NgrokSecretStorage {
	get(): Thenable<string | undefined> {
		return Promise.resolve(undefined);
	}

	store(): Thenable<void> {
		return Promise.resolve();
	}
}

/**
 * The ngrok authtoken never enters the settings API. That route is reachable through the public
 * tunnel, so the token lives in the extension's secret storage and the dashboard only learns
 * whether one is saved. A stored value that cannot be an authtoken (a pasted URL, for example)
 * counts as not saved, so the dashboard asks for the token again instead of starting ngrok with it.
 */
export class NgrokTokenStore {
	constructor(private readonly secrets: NgrokSecretStorage) {}

	async read(): Promise<string | null> {
		const stored = await this.secrets.get(SECRET_KEY);

		return NgrokAuthToken.normalize(stored);
	}

	async isSet(): Promise<boolean> {
		const token = await this.read();

		return token !== null;
	}

	async save(token: string): Promise<void> {
		if (!token.trim()) {
			throw new Error('The ngrok authtoken is empty');
		}

		const normalized = NgrokAuthToken.normalize(token);

		if (!normalized) {
			throw new Error('That is not an ngrok authtoken. Copy the authtoken from dashboard.ngrok.com, not a URL');
		}

		await this.secrets.store(SECRET_KEY, normalized);
	}
}
