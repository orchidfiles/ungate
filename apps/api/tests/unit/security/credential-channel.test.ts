import { PROVIDER_SECRET_CHANNEL } from '@ungate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CredentialChannelMissingError, requireCredentialChannel } from 'src/security/credential-channel';
import { ProviderSecrets, useProviderSecretTransport } from 'src/security/provider-secrets';

import { createHostWithoutIpc, FakeIpcHost } from '../../helpers/fake-ipc-host';

describe('requireCredentialChannel', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		useProviderSecretTransport(null);
	});

	afterEach(() => {
		useProviderSecretTransport(null);
		vi.restoreAllMocks();
	});

	it('refuses to start without an ipc credential channel', async () => {
		const host = createHostWithoutIpc();

		expect(() => requireCredentialChannel(host)).toThrow(CredentialChannelMissingError);

		// No transport was installed and no lifecycle handler was registered.
		await expect(ProviderSecrets.write('claude', { accessToken: 'a', refreshToken: null })).rejects.toThrow(/unavailable/);
		expect(host.listenerCount('disconnect')).toBe(0);
		expect(host.exitCode).toBeNull();
	});

	it('installs the transport so credential requests reach the extension', async () => {
		const host = new FakeIpcHost();

		requireCredentialChannel(host);

		const pending = ProviderSecrets.read('claude');
		const request = host.lastRequest();

		expect(request).toMatchObject({ channel: PROVIDER_SECRET_CHANNEL, action: 'get', provider: 'claude' });

		host.emit('message', {
			channel: PROVIDER_SECRET_CHANNEL,
			id: request.id,
			ok: true,
			secret: { accessToken: 'access', refreshToken: null }
		});

		await expect(pending).resolves.toEqual({ accessToken: 'access', refreshToken: null });
		expect(host.exitCode).toBeNull();
	});

	it('ends the process when the channel is lost, after rejecting in-flight requests', async () => {
		const host = new FakeIpcHost();

		requireCredentialChannel(host);

		const inFlight = ProviderSecrets.write('minimax', { accessToken: 'key', refreshToken: null });

		host.emit('disconnect');

		await expect(inFlight).rejects.toThrow(/closed the credential channel/);
		expect(host.exitCode).toBe(0);
	});
});
