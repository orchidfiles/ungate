import { ADMIN_KEY_MIN_LENGTH, ADMIN_KEY_SECRET_KEY } from '@ungate/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminKey, type SecretStore } from '../../src/admin-key';

/** Stands in for vscode.SecretStorage. */
class MemorySecretStore implements SecretStore {
	readonly values: Record<string, string> = {};
	failOn: string | null = null;

	get(key: string): Promise<string | undefined> {
		return Promise.resolve(this.values[key]);
	}

	store(key: string, value: string): Promise<void> {
		if (this.failOn === key) {
			return Promise.reject(new Error('keychain is locked'));
		}

		this.values[key] = value;

		return Promise.resolve();
	}
}

describe('AdminKey', () => {
	let storage: MemorySecretStore;

	beforeEach(() => {
		storage = new MemorySecretStore();
	});

	it('mints a 256-bit key once and reuses the stored one', async () => {
		const first = await AdminKey.load(storage);

		expect(first.length).toBeGreaterThanOrEqual(ADMIN_KEY_MIN_LENGTH);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(storage.values[ADMIN_KEY_SECRET_KEY]).toBe(first);

		const second = await AdminKey.load(storage);

		expect(second).toBe(first);
	});

	it('mints a distinct key per install', async () => {
		const other = new MemorySecretStore();
		const first = await AdminKey.load(storage);
		const second = await AdminKey.load(other);

		expect(first).not.toBe(second);
	});

	it('replaces a stored key that is too short to carry 256 bits', async () => {
		storage.values[ADMIN_KEY_SECRET_KEY] = 'too-short';

		const key = await AdminKey.load(storage);

		expect(key).not.toBe('too-short');
		expect(key.length).toBeGreaterThanOrEqual(ADMIN_KEY_MIN_LENGTH);
		expect(storage.values[ADMIN_KEY_SECRET_KEY]).toBe(key);
	});

	it('fails closed when secret storage refuses the write', async () => {
		// Without a key there is nothing to gate the administrative routes with, so activation
		// must fail rather than continue and spawn an API that cannot be locked.
		storage.failOn = ADMIN_KEY_SECRET_KEY;

		await expect(AdminKey.load(storage)).rejects.toThrow('keychain is locked');
	});

	it('never stores the key anywhere but the administrative secret slot', async () => {
		await AdminKey.load(storage);

		expect(Object.keys(storage.values)).toEqual([ADMIN_KEY_SECRET_KEY]);
	});
});
