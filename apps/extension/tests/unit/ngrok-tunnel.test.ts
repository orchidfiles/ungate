import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NgrokTokenStore, type NgrokSecretStorage } from '../../src/ngrok-token-store';
import { TunnelManager } from '../../src/tunnel-manager';
import { NgrokInstaller } from '../../src/utils/ngrok-installer';

import type { LogEntry, TunnelState } from '@ungate/shared/frontend';

const TOKEN = 'ungateUnitTestToken_0123456789';

const mocks = vi.hoisted(() => {
	return {
		runtimeReadMock: vi.fn<() => { tunnelProvider: string; ngrokDomain: string | null; tunnel: { url: string | null } }>(() => ({
			tunnelProvider: 'ngrok',
			ngrokDomain: null,
			tunnel: { url: null }
		})),
		spawnMock: vi.fn()
	};
});

vi.mock('node:child_process', () => {
	return {
		spawn: (...args: unknown[]) => mocks.spawnMock(...args)
	};
});

vi.mock('../../src/runtime-state', () => {
	return {
		CloudflaredProcess: {
			findServing: () => null
		},
		RuntimeStateStore: {
			mutate: vi.fn((mutator: (state: unknown) => unknown) => Promise.resolve(mutator({ tunnel: {} }))),
			read: () => mocks.runtimeReadMock(),
			hasLiveClients: vi.fn(() => true)
		}
	};
});

class FakeProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly killed: string[] = [];

	kill(): void {
		this.killed.push('kill');
	}
}

function secrets(token: string | undefined): NgrokSecretStorage {
	return {
		get: () => Promise.resolve(token),
		store: () => Promise.resolve()
	};
}

function createManager(token: string | undefined): { manager: TunnelManager; states: TunnelState[]; logs: LogEntry[] } {
	const states: TunnelState[] = [];
	const logs: LogEntry[] = [];
	const manager = new TunnelManager(
		'window-a',
		() => true,
		(state) => {
			states.push(state);
		},
		(entry) => {
			logs.push(entry);
		},
		new NgrokTokenStore(secrets(token))
	);

	return { manager, states, logs };
}

describe('ngrok tunnel', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		mocks.spawnMock.mockReset();
		mocks.runtimeReadMock.mockReturnValue({ tunnelProvider: 'ngrok', ngrokDomain: null, tunnel: { url: null } });
	});

	it('fails closed when the authtoken is missing', async () => {
		const { manager } = createManager(undefined);

		await manager.start(47821);

		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'Add an ngrok authtoken before starting the stable tunnel'
		});
		expect(mocks.spawnMock).not.toHaveBeenCalled();
	});

	it('launches ngrok against the current port and keeps the parsed url', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);

		expect(mocks.spawnMock).toHaveBeenCalledWith(
			expect.stringMatching(/ngrok$/),
			['http', '47821', '--log', 'stdout', '--log-format', 'json'],
			expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'], env: expect.objectContaining({ NGROK_AUTHTOKEN: TOKEN }) })
		);

		child.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://stable.ngrok-free.app"}\n'));

		expect(manager.getState()).toEqual({
			status: 'running',
			url: 'https://stable.ngrok-free.app',
			error: null
		});
	});

	it('relaunches ngrok on the new port without changing the public url', async () => {
		const first = new FakeProcess();
		const second = new FakeProcess();

		mocks.spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);
		first.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://stable.ngrok-free.app"}\n'));

		await manager.restart(47822);
		second.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://stable.ngrok-free.app"}\n'));

		expect(first.killed).toEqual(['kill']);
		expect(mocks.spawnMock).toHaveBeenLastCalledWith(
			expect.stringMatching(/ngrok$/),
			['http', '47822', '--log', 'stdout', '--log-format', 'json'],
			expect.any(Object)
		);
		first.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://obsolete.ngrok-free.app"}\n'));
		first.stderr.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://obsolete.ngrok-free.app"}\n'));
		first.emit('error', new Error('Late error from stopped process'));
		first.emit('exit', 0, 'SIGTERM');

		expect(manager.getState()).toEqual({
			status: 'running',
			url: 'https://stable.ngrok-free.app',
			error: null
		});

		manager.stop();
		expect(second.killed).toEqual(['kill']);
	});

	it('flags a rejected dev domain, keeps the tunnel running and keeps the name out of the log', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager, logs, states } = createManager(TOKEN);

		await manager.start(47821);
		child.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://acre-idiot-case.ngrok-free.dev"}\n'));
		child.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://acre-idiot-case.ngrok-free.dev"}\n'));

		expect(manager.getState()).toEqual({
			status: 'running',
			url: null,
			error: null,
			warning: 'offensive-hostname'
		});
		expect(child.killed).toEqual([]);
		expect(JSON.stringify([logs, states])).not.toContain('idiot');
		expect(logs.filter((entry) => entry.level === 'warn')).toHaveLength(1);
		expect(logs.map((entry) => entry.message)).toContain(
			'{"msg":"started tunnel","url":"https://hidden-hostname.ngrok-free.dev"}'
		);
	});

	it('does not flag an ordinary dev domain', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager, logs } = createManager(TOKEN);

		await manager.start(47821);
		child.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://acre-case-gibberish.ngrok-free.dev"}\n'));

		expect(manager.getState()).toEqual({ status: 'running', url: 'https://acre-case-gibberish.ngrok-free.dev', error: null });
		expect(logs.map((entry) => entry.message)).toContain('Tunnel URL: https://acre-case-gibberish.ngrok-free.dev');
	});

	it('passes a configured domain as --url and does not screen the name the user chose', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		mocks.runtimeReadMock.mockReturnValue({
			tunnelProvider: 'ngrok',
			ngrokDomain: 'Stupid-Api.Example.com',
			tunnel: { url: null }
		});
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);

		expect(mocks.spawnMock).toHaveBeenCalledWith(
			expect.stringMatching(/ngrok$/),
			['http', '47821', '--url', 'https://stupid-api.example.com', '--log', 'stdout', '--log-format', 'json'],
			expect.any(Object)
		);

		child.stdout.emit('data', Buffer.from('{"msg":"started tunnel","url":"https://stupid-api.ngrok.app"}\n'));

		expect(manager.getState()).toEqual({ status: 'running', url: 'https://stupid-api.ngrok.app', error: null });
	});

	it('ignores a stored domain that is not a plain hostname', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		mocks.runtimeReadMock.mockReturnValue({
			tunnelProvider: 'ngrok',
			ngrokDomain: 'example.com --config /tmp/x',
			tunnel: { url: null }
		});
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);

		expect(mocks.spawnMock.mock.calls[0][1]).toEqual(['http', '47821', '--log', 'stdout', '--log-format', 'json']);
	});

	it('reports a rejected authtoken as an error and never publishes the dashboard link as the tunnel url', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager, logs, states } = createManager(TOKEN);
		const authError =
			'authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.\\nInstructions to install your authtoken are on your ngrok dashboard:\\nhttps://dashboard.ngrok.com/get-started/your-authtoken\\r\\n\\r\\nERR_NGROK_105\\r\\n';

		await manager.start(47821);
		child.stdout.emit(
			'data',
			Buffer.from(
				[
					`{"t":"2026-11-23T17:19:45-0700","lvl":"eror","msg":"failed to reconnect session","obj":"tunnels.session","err":"${authError}"}`,
					'{"t":"2026-11-23T17:19:45-0700","lvl":"info","msg":"ERROR terminating with error obj=app err=\\"authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.\\\\nhttps://dashboard.ngrok.com/get-started/your-authtoken\\\\r\\\\n\\\\r\\\\nERR_NGROK_105\\\\r\\\\n\\""}',
					`{"t":"2026-11-23T17:19:45-0700","lvl":"crit","msg":"command failed","err":"${authError}"}`,
					''
				].join('\n')
			)
		);
		child.stderr.emit(
			'data',
			Buffer.from(
				'ERROR:  authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.\nERROR:  Instructions to install your authtoken are on your ngrok dashboard:\nERROR:  https://dashboard.ngrok.com/get-started/your-authtoken\r\nERROR:  \r\nERROR:  ERR_NGROK_105\r\nERROR:  https://ngrok.com/docs/errors/err_ngrok_105\r\nERROR:  \n'
			)
		);

		expect(manager.getState()).toEqual({ status: 'starting', url: null, error: null });

		child.emit('exit', 1, null);

		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error:
				'ngrok: authentication failed: The authtoken you specified does not look like a proper ngrok authtoken. (ERR_NGROK_105)'
		});
		expect(states.every((state) => state.url === null)).toBe(true);
		expect(logs.map((entry) => entry.message).some((message) => message.startsWith('Tunnel URL:'))).toBe(false);
		expect(logs.filter((entry) => entry.level === 'error').length).toBeGreaterThan(0);
	});

	it('builds the error from plain stderr lines when ngrok prints no json failure', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);
		child.stderr.emit(
			'data',
			Buffer.from('ERROR:  authentication failed: This ngrok session is not authenticated.\nERROR:  \nERROR:  Sign up')
		);
		child.stderr.emit('data', Buffer.from(' for an account: https://dashboard.ngrok.com/signup\nERROR:  ERR_NGROK_4018\r\n'));
		child.emit('exit', 1, null);

		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'ngrok: authentication failed: This ngrok session is not authenticated. (ERR_NGROK_4018)'
		});
	});

	it('reports why a running tunnel died instead of a clean stop', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);
		child.stdout.emit('data', Buffer.from('{"lvl":"info","msg":"started tunnel","url":"https://stable.ngrok-free.app"}\n'));
		expect(manager.getState().status).toBe('running');

		child.stdout.emit(
			'data',
			Buffer.from(
				'{"lvl":"crit","msg":"command failed","err":"Your account is limited to 1 simultaneous ngrok agent sessions.\\r\\n\\r\\nERR_NGROK_108\\r\\n"}\n'
			)
		);
		child.emit('exit', 1, null);

		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'ngrok: Your account is limited to 1 simultaneous ngrok agent sessions. (ERR_NGROK_108)'
		});
	});

	it('keeps the generic message when ngrok exits early without explaining itself', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);
		child.emit('exit', 2, null);

		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'Process exited before tunnel was ready (code=2)'
		});
	});

	it('reads a started tunnel event that arrives split across two chunks', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);
		child.stdout.emit('data', Buffer.from('{"lvl":"info","msg":"started tunnel","url":"https://sta'));
		expect(manager.getState().status).toBe('starting');
		child.stdout.emit('data', Buffer.from('ble.ngrok-free.app"}\n'));

		expect(manager.getState()).toEqual({ status: 'running', url: 'https://stable.ngrok-free.app', error: null });
	});

	it('keeps the authtoken out of the process arguments', async () => {
		const child = new FakeProcess();

		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(true);

		const { manager } = createManager(TOKEN);

		await manager.start(47821);

		expect(JSON.stringify(mocks.spawnMock.mock.calls[0][1])).not.toContain(TOKEN);
		expect(mocks.spawnMock.mock.calls[0][1]).not.toContain('--authtoken');
	});

	it('treats a tunnel url saved in the authtoken slot as no authtoken', async () => {
		const { manager } = createManager('https://badge-bug-substances.trycloudflare.com/v1');

		await manager.start(47821);

		expect(manager.getState().error).toBe('Add an ngrok authtoken before starting the stable tunnel');
		expect(mocks.spawnMock).not.toHaveBeenCalled();
	});

	it('reports a failed ngrok install instead of starting a process', async () => {
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(false);
		vi.spyOn(NgrokInstaller, 'install').mockRejectedValue(new Error('No pinned ngrok binary'));

		const { manager } = createManager(TOKEN);

		await manager.start(47821);

		expect(manager.getState().status).toBe('error');
		expect(manager.getState().error).toBe('Install failed: No pinned ngrok binary');
		expect(mocks.spawnMock).not.toHaveBeenCalled();
	});

	it('does not launch ngrok when stopped while the binary is installing', async () => {
		let finishInstall: (path: string) => void = () => {};
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(false);
		vi.spyOn(NgrokInstaller, 'install').mockReturnValue(
			new Promise((resolve) => {
				finishInstall = resolve;
			})
		);

		const { manager } = createManager(TOKEN);
		const starting = manager.start(47821);
		await vi.waitFor(() => expect(manager.getState().status).toBe('installing'));

		manager.stop();
		finishInstall('/tmp/ngrok');
		await starting;

		expect(mocks.spawnMock).not.toHaveBeenCalled();
		expect(manager.getState()).toEqual({ status: 'stopped', url: null, error: null });
	});

	it('launches only the latest start when restarted while installing', async () => {
		const child = new FakeProcess();
		let finishInstall: (path: string) => void = () => {};
		mocks.spawnMock.mockReturnValue(child);
		const pinned = vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(false);
		vi.spyOn(NgrokInstaller, 'install').mockReturnValue(
			new Promise((resolve) => {
				finishInstall = resolve;
			})
		);

		const { manager } = createManager(TOKEN);
		const first = manager.start(47821);
		await vi.waitFor(() => expect(manager.getState().status).toBe('installing'));

		pinned.mockReturnValue(true);
		await manager.restart(47822);
		finishInstall('/tmp/ngrok');
		await first;

		expect(mocks.spawnMock).toHaveBeenCalledTimes(1);
		expect(mocks.spawnMock.mock.calls[0][1]).toContain('47822');
	});
});
