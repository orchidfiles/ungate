import { PROVIDER_SECRET_CHANNEL } from '@ungate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcSecretTransport } from 'src/security/ipc-secret-transport';
import { ProviderSecrets, SecretStorageUnavailableError, useProviderSecretTransport } from 'src/security/provider-secrets';

import { createHostWithoutIpc, FakeIpcHost } from '../../helpers/fake-ipc-host';

describe('IpcSecretTransport', () => {
	let host: FakeIpcHost;

	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		host = new FakeIpcHost();
		IpcSecretTransport.install(host);
	});

	afterEach(() => {
		useProviderSecretTransport(null);
		vi.restoreAllMocks();
	});

	it('sends a validated request and resolves with the returned credential', async () => {
		const pending = ProviderSecrets.read('claude');
		const request = host.lastRequest();

		expect(request).toMatchObject({ channel: PROVIDER_SECRET_CHANNEL, action: 'get', provider: 'claude' });
		expect(request.id).toBeTypeOf('string');
		expect(request.secret).toBeUndefined();

		host.emit('message', {
			channel: PROVIDER_SECRET_CHANNEL,
			id: request.id,
			ok: true,
			secret: { accessToken: 'access', refreshToken: 'refresh' }
		});

		await expect(pending).resolves.toEqual({ accessToken: 'access', refreshToken: 'refresh' });
	});

	it('carries the credential on a set request and resolves once acknowledged', async () => {
		const pending = ProviderSecrets.write('minimax', { accessToken: 'key', refreshToken: null });
		const request = host.lastRequest();

		expect(request).toMatchObject({
			action: 'set',
			provider: 'minimax',
			secret: { accessToken: 'key', refreshToken: null }
		});

		host.emit('message', { channel: PROVIDER_SECRET_CHANNEL, id: request.id, ok: true, secret: null });

		await expect(pending).resolves.toBeUndefined();
	});

	it('rejects a malformed response instead of trusting it', async () => {
		const pending = ProviderSecrets.write('claude', { accessToken: 'a', refreshToken: null });
		const request = host.lastRequest();

		host.emit('message', { channel: PROVIDER_SECRET_CHANNEL, id: request.id, ok: 'yes' });

		await expect(pending).rejects.toThrow(SecretStorageUnavailableError);
	});

	it('surfaces a refusal reported by the extension', async () => {
		const pending = ProviderSecrets.write('claude', { accessToken: 'a', refreshToken: null });
		const request = host.lastRequest();

		host.emit('message', { channel: PROVIDER_SECRET_CHANNEL, id: request.id, ok: false, error: 'keychain locked' });

		await expect(pending).rejects.toThrow(/keychain locked/);
	});

	it('ignores responses that do not correlate with a pending request', async () => {
		const pending = ProviderSecrets.read('openai');
		const request = host.lastRequest();
		let settled = false;

		void pending.then(() => {
			settled = true;
		});

		host.emit('message', { channel: 'some-other-channel', id: request.id, ok: true, secret: null });
		host.emit('message', { channel: PROVIDER_SECRET_CHANNEL, id: 'not-a-pending-id', ok: true, secret: null });
		host.emit('message', 'garbage');
		await Promise.resolve();

		expect(settled).toBe(false);

		host.emit('message', { channel: PROVIDER_SECRET_CHANNEL, id: request.id, ok: true, secret: null });

		await expect(pending).resolves.toBeNull();
	});

	it('rejects in-flight and later requests once the channel disconnects', async () => {
		const inFlight = ProviderSecrets.write('claude', { accessToken: 'a', refreshToken: null });

		host.emit('disconnect');

		await expect(inFlight).rejects.toThrow(SecretStorageUnavailableError);
		await expect(ProviderSecrets.write('claude', { accessToken: 'b', refreshToken: null })).rejects.toThrow(
			SecretStorageUnavailableError
		);
		// Reads deny instead of throwing so provider calls answer 401.
		await expect(ProviderSecrets.read('claude')).resolves.toBeNull();
	});
});

describe('ProviderSecrets without a transport', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		useProviderSecretTransport(null);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('installs nothing when the process has no ipc channel', () => {
		expect(IpcSecretTransport.install(createHostWithoutIpc())).toBeNull();
	});

	it('denies reads and refuses writes', async () => {
		await expect(ProviderSecrets.read('claude')).resolves.toBeNull();
		await expect(ProviderSecrets.write('claude', { accessToken: 'a', refreshToken: null })).rejects.toThrow(
			SecretStorageUnavailableError
		);
		await expect(ProviderSecrets.erase('claude')).rejects.toThrow(SecretStorageUnavailableError);
	});
});
