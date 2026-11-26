import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NgrokTokenStore, type NgrokSecretStorage } from '../../src/ngrok-token-store';
import { NgrokUrl } from '../../src/ngrok-url';
import { TunnelManager } from '../../src/tunnel-manager';
import { NgrokInstaller } from '../../src/utils/ngrok-installer';

import type { TunnelState } from '@ungate/shared/frontend';

const mocks = vi.hoisted(() => {
	return {
		runtimeReadMock: vi.fn(() => ({
			tunnelProvider: 'ngrok',
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

function createManager(token: string | undefined): { manager: TunnelManager; states: TunnelState[] } {
	const states: TunnelState[] = [];
	const manager = new TunnelManager(
		'window-a',
		() => true,
		(state) => {
			states.push(state);
		},
		() => {},
		new NgrokTokenStore(secrets(token))
	);

	return { manager, states };
}

describe('ngrok tunnel', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		mocks.spawnMock.mockReset();
	});

	it('reads the stable url from ngrok json logs', () => {
		expect(NgrokUrl.read('{"url":"https://stable.ngrok-free.app"}')).toBe('https://stable.ngrok-free.app');
		expect(NgrokUrl.read('started tunnel https://stable.ngrok-free.dev')).toBe('https://stable.ngrok-free.dev');
		expect(NgrokUrl.read('http://stable.ngrok-free.app')).toBeNull();
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

		const { manager } = createManager('token-1');

		await manager.start(47821);

		expect(mocks.spawnMock).toHaveBeenCalledWith(
			expect.stringMatching(/ngrok$/),
			['http', '47821', '--authtoken', 'token-1', '--log', 'stdout', '--log-format', 'json'],
			expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
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

		const { manager } = createManager('token-1');

		await manager.start(47821);
		first.stdout.emit('data', Buffer.from('https://stable.ngrok-free.app\n'));

		await manager.restart(47822);
		second.stdout.emit('data', Buffer.from('https://stable.ngrok-free.app\n'));

		expect(first.killed).toEqual(['kill']);
		expect(mocks.spawnMock).toHaveBeenLastCalledWith(
			expect.stringMatching(/ngrok$/),
			['http', '47822', '--authtoken', 'token-1', '--log', 'stdout', '--log-format', 'json'],
			expect.any(Object)
		);
		first.stdout.emit('data', Buffer.from('https://obsolete.ngrok-free.app\n'));
		first.stderr.emit('data', Buffer.from('https://obsolete.ngrok-free.app\n'));
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

	it('reports a failed ngrok install instead of starting a process', async () => {
		vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(false);
		vi.spyOn(NgrokInstaller, 'install').mockRejectedValue(new Error('No pinned ngrok binary'));

		const { manager } = createManager('token-1');

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

		const { manager } = createManager('token-1');
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

		const { manager } = createManager('token-1');
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
