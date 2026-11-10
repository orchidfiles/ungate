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
 * whether one is saved.
 */
export class NgrokTokenStore {
	constructor(private readonly secrets: NgrokSecretStorage) {}

	async read(): Promise<string | null> {
		const stored = await this.secrets.get(SECRET_KEY);
		const token = stored?.trim();

		return token ?? null;
	}

	async isSet(): Promise<boolean> {
		const token = await this.read();

		return token !== null;
	}

	async save(token: string): Promise<void> {
		const trimmed = token.trim();

		if (!trimmed) {
			throw new Error('The ngrok authtoken is empty');
		}

		await this.secrets.store(SECRET_KEY, trimmed);
	}
}
