import { ADMIN_KEY_MIN_LENGTH, ADMIN_KEY_SECRET_KEY, PROVIDER_SECRET_CHANNEL } from '@ungate/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { SecuritySecrets, type SecretStore } from '../../src/security-secrets';

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

	delete(key: string): Promise<void> {
		delete this.values[key];

		return Promise.resolve();
	}
}

const CLAUDE_KEY = 'ungate.provider.claude';

function getRequest(id: string, provider = 'claude'): unknown {
	return { channel: PROVIDER_SECRET_CHANNEL, id, action: 'get', provider };
}

describe('SecuritySecrets', () => {
	let storage: MemorySecretStore;

	beforeEach(() => {
		storage = new MemorySecretStore();
	});

	it('mints a 256-bit admin key once and reuses the stored one', async () => {
		const first = await SecuritySecrets.create(storage);

		expect(first.adminApiKey.length).toBeGreaterThanOrEqual(ADMIN_KEY_MIN_LENGTH);
		expect(first.adminApiKey).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(storage.values[ADMIN_KEY_SECRET_KEY]).toBe(first.adminApiKey);

		const second = await SecuritySecrets.create(storage);

		expect(second.adminApiKey).toBe(first.adminApiKey);
	});

	it('replaces a stored admin key that is too short to carry 256 bits', async () => {
		storage.values[ADMIN_KEY_SECRET_KEY] = 'too-short';

		const secrets = await SecuritySecrets.create(storage);

		expect(secrets.adminApiKey).not.toBe('too-short');
		expect(secrets.adminApiKey.length).toBeGreaterThanOrEqual(ADMIN_KEY_MIN_LENGTH);
	});

	it('stores, reads and deletes provider credentials under a constant key', async () => {
		const secrets = await SecuritySecrets.create(storage);

		const stored = await secrets.handleApiChildMessage({
			channel: PROVIDER_SECRET_CHANNEL,
			id: 'r1',
			action: 'set',
			provider: 'claude',
			secret: { accessToken: 'access', refreshToken: 'refresh' }
		});

		expect(stored).toEqual({ channel: PROVIDER_SECRET_CHANNEL, id: 'r1', ok: true, secret: null });
		expect(storage.values[CLAUDE_KEY]).toBe(JSON.stringify({ accessToken: 'access', refreshToken: 'refresh' }));

		const read = await secrets.handleApiChildMessage(getRequest('r2'));

		expect(read).toEqual({
			channel: PROVIDER_SECRET_CHANNEL,
			id: 'r2',
			ok: true,
			secret: { accessToken: 'access', refreshToken: 'refresh' }
		});

		const deleted = await secrets.handleApiChildMessage({
			channel: PROVIDER_SECRET_CHANNEL,
			id: 'r3',
			action: 'delete',
			provider: 'claude'
		});

		expect(deleted).toEqual({ channel: PROVIDER_SECRET_CHANNEL, id: 'r3', ok: true, secret: null });
		expect(storage.values[CLAUDE_KEY]).toBeUndefined();
		await expect(secrets.handleApiChildMessage(getRequest('r4'))).resolves.toEqual({
			channel: PROVIDER_SECRET_CHANNEL,
			id: 'r4',
			ok: true,
			secret: null
		});
	});

	it('ignores messages that do not belong to the credential channel', async () => {
		const secrets = await SecuritySecrets.create(storage);

		await expect(secrets.handleApiChildMessage({ type: 'webview-ready' })).resolves.toBeNull();
		await expect(secrets.handleApiChildMessage('garbage')).resolves.toBeNull();
		await expect(secrets.handleApiChildMessage(null)).resolves.toBeNull();
		// Channel matches but the correlation id is missing, so there is nobody to answer.
		await expect(secrets.handleApiChildMessage({ channel: PROVIDER_SECRET_CHANNEL, action: 'get' })).resolves.toBeNull();
	});

	it('answers malformed credential requests with an error instead of acting on them', async () => {
		const secrets = await SecuritySecrets.create(storage);
		const malformed: unknown[] = [
			{ channel: PROVIDER_SECRET_CHANNEL, id: 'm1', action: 'wipe', provider: 'claude' },
			{ channel: PROVIDER_SECRET_CHANNEL, id: 'm2', action: 'get', provider: 'anthropic' },
			{ channel: PROVIDER_SECRET_CHANNEL, id: 'm3', action: 'set', provider: 'claude' },
			{ channel: PROVIDER_SECRET_CHANNEL, id: 'm4', action: 'set', provider: 'claude', secret: { accessToken: 42 } },
			{ channel: PROVIDER_SECRET_CHANNEL, id: 'm5', action: 'delete', provider: 'claude', secret: { accessToken: 'x' } }
		];

		for (const message of malformed) {
			await expect(secrets.handleApiChildMessage(message)).resolves.toMatchObject({ ok: false });
		}

		expect(storage.values[CLAUDE_KEY]).toBeUndefined();
	});

	it('treats an unreadable stored credential as absent', async () => {
		const secrets = await SecuritySecrets.create(storage);
		storage.values[CLAUDE_KEY] = 'not json';

		await expect(secrets.handleApiChildMessage(getRequest('r5'))).resolves.toMatchObject({ ok: true, secret: null });

		storage.values[CLAUDE_KEY] = JSON.stringify({ accessToken: 7 });

		await expect(secrets.handleApiChildMessage(getRequest('r6'))).resolves.toMatchObject({ ok: true, secret: null });
	});

	it('reports storage failures without echoing the credential', async () => {
		const secrets = await SecuritySecrets.create(storage);
		storage.failOn = CLAUDE_KEY;

		const response = await secrets.handleApiChildMessage({
			channel: PROVIDER_SECRET_CHANNEL,
			id: 'r7',
			action: 'set',
			provider: 'claude',
			secret: { accessToken: 'super-secret-token', refreshToken: null }
		});

		expect(response).toEqual({
			channel: PROVIDER_SECRET_CHANNEL,
			id: 'r7',
			ok: false,
			error: 'Secret storage rejected set for claude: keychain is locked'
		});
		expect(JSON.stringify(response)).not.toContain('super-secret-token');
	});
});
