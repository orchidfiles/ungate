import { randomBytes } from 'node:crypto';

import { ADMIN_KEY_MIN_LENGTH, ADMIN_KEY_SECRET_KEY } from '@ungate/shared';

/**
 * The slice of `vscode.SecretStorage` this module needs. Narrowing it keeps the key logic
 * independent of the `vscode` module so it can be driven directly.
 */
export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
}

/**
 * Owner of the administrative API key that gates the settings, provider-auth and analytics
 * routes. It lives only in VS Code SecretStorage, the API child's environment and the
 * dashboard webview — never in SQLite, the runtime state file or the log. Provider
 * credentials are not this module's business; they stay where they already live.
 */
export class AdminKey {
	/** Loads the key, minting a 256-bit one on first run or when the stored value is unusable. */
	static async load(storage: SecretStore): Promise<string> {
		const stored = await storage.get(ADMIN_KEY_SECRET_KEY);

		if (stored && stored.length >= ADMIN_KEY_MIN_LENGTH) {
			return stored;
		}

		const minted = randomBytes(32).toString('base64url');

		await storage.store(ADMIN_KEY_SECRET_KEY, minted);

		return minted;
	}
}
