import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		killMock: vi.fn(),
		runtimeReadMock: vi.fn<
			() => {
				clients: object;
				tunnelProvider: string;
				tunnel: { url: string | null; pid: number | null; metricsPort: number | null };
			}
		>(),
		isRunningCommandMock: vi.fn<(pid: number, port: number | null) => boolean>(() => false)
	};
});

vi.mock('cloudflared', () => {
	return {
		bin: '/dev/cloudflared-package/bin/cloudflared',
		use: vi.fn()
	};
});

vi.mock('../../src/detached-cloudflared', async () => {
	const { FakeDetachedCloudflared } = await import('./helpers/fake-detached-cloudflared');

	return { DetachedCloudflared: FakeDetachedCloudflared };
});

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();

	return {
		...original,
		existsSync: () => true
	};
});

vi.mock('../../src/runtime-state', () => {
	return {
		CloudflaredProcess: {
			isRunningCommand: (pid: number, port: number | null) => mocks.isRunningCommandMock(pid, port)
		},
		RuntimeStateStore: {
			mutate: vi.fn((mutator: (state: { tunnel: object }) => unknown) => Promise.resolve(mutator({ tunnel: {} }))),
			read: () => mocks.runtimeReadMock(),
			hasLiveClients: vi.fn(() => true)
		}
	};
});

import { config } from '../../src/runtime-state/config';
import { TunnelManager } from '../../src/tunnel-manager';

import { FakeDetachedCloudflared } from './helpers/fake-detached-cloudflared';

const KEPT_URL = 'https://kept.trycloudflare.com';

function createManager(): TunnelManager {
	return new TunnelManager(
		'window-a',
		() => true,
		() => {},
		() => {}
	);
}

describe('TunnelManager quick tunnel adoption and retry', () => {
	const { startRetryDelaysMs, startRetryLongDelayMs } = config.tunnelManager;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeDetachedCloudflared.reset();
		mocks.killMock.mockReset();
		mocks.isRunningCommandMock.mockReset();
		mocks.isRunningCommandMock.mockReturnValue(false);
		mocks.runtimeReadMock.mockReset();
		mocks.runtimeReadMock.mockReturnValue({
			clients: {},
			tunnelProvider: 'quick',
			tunnel: { url: null, pid: null, metricsPort: null }
		});
		vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
			mocks.killMock(pid);

			return true;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('adopts a surviving tunnel when the pid is live and the metrics hostname matches', async () => {
		mocks.isRunningCommandMock.mockReturnValue(true);
		FakeDetachedCloudflared.reportedHostname = 'kept.trycloudflare.com';
		mocks.runtimeReadMock.mockReturnValue({
			clients: {},
			tunnelProvider: 'quick',
			tunnel: { url: KEPT_URL, pid: 42, metricsPort: 45000 }
		});
		const manager = createManager();

		await manager.start(47821);

		expect(manager.getState()).toEqual({ status: 'running', url: KEPT_URL, error: null });
		expect(FakeDetachedCloudflared.starts).toHaveLength(0);
		expect(FakeDetachedCloudflared.attachments).toEqual([
			expect.objectContaining({ pid: 42, metricsPort: 45000, originPort: 47821 })
		]);
		expect(mocks.killMock).not.toHaveBeenCalled();
	});

	it('starts a new tunnel when the metrics hostname does not match the recorded url', async () => {
		mocks.isRunningCommandMock.mockReturnValue(true);
		FakeDetachedCloudflared.reportedHostname = 'other.trycloudflare.com';
		mocks.runtimeReadMock.mockReturnValue({
			clients: {},
			tunnelProvider: 'quick',
			tunnel: { url: KEPT_URL, pid: 42, metricsPort: 45000 }
		});
		const manager = createManager();

		await manager.start(47821);

		expect(mocks.killMock).toHaveBeenCalledWith(42);
		expect(FakeDetachedCloudflared.starts).toHaveLength(1);
		expect(FakeDetachedCloudflared.starts[0]?.origin).toBe('http://127.0.0.1:47821');
		expect(manager.getState().status).toBe('starting');
		expect(manager.getState().url).toBeNull();
	});

	it('retries a failed start with backoff and then the long delay', async () => {
		const manager = createManager();

		await manager.start(47821);

		for (let index = 0; index < startRetryDelaysMs.length; index++) {
			expect(FakeDetachedCloudflared.spawned).toHaveLength(index + 1);
			FakeDetachedCloudflared.spawned[index].emitExit('dns timeout');
			expect(manager.getState()).toEqual({
				status: 'error',
				url: null,
				error: `Attempt ${index + 1} failed: dns timeout`
			});
			await vi.advanceTimersByTimeAsync(startRetryDelaysMs[index] - 1);
			expect(FakeDetachedCloudflared.spawned).toHaveLength(index + 1);
			await vi.advanceTimersByTimeAsync(1);
		}

		expect(FakeDetachedCloudflared.spawned).toHaveLength(startRetryDelaysMs.length + 1);
		FakeDetachedCloudflared.spawned[startRetryDelaysMs.length].emitExit('dns timeout');
		await vi.advanceTimersByTimeAsync(startRetryLongDelayMs - 1);
		expect(FakeDetachedCloudflared.spawned).toHaveLength(startRetryDelaysMs.length + 1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeDetachedCloudflared.spawned).toHaveLength(startRetryDelaysMs.length + 2);
	});

	it('uses the long delay when the log contains status 429', async () => {
		const manager = createManager();

		await manager.start(47821);
		FakeDetachedCloudflared.spawned[0].emitLog('ERR failed to request quick Tunnel: status 429');
		FakeDetachedCloudflared.spawned[0].emitExit('status 429');

		expect(manager.getState().error).toBe('Attempt 1 failed: ERR failed to request quick Tunnel: status 429');
		await vi.advanceTimersByTimeAsync(startRetryDelaysMs[0]);
		expect(FakeDetachedCloudflared.spawned).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(startRetryLongDelayMs - startRetryDelaysMs[0]);
		expect(FakeDetachedCloudflared.spawned).toHaveLength(2);
	});

	it('cancels a pending retry when the tunnel is stopped', async () => {
		const manager = createManager();

		await manager.start(47821);
		FakeDetachedCloudflared.spawned[0].emitExit('dns timeout');
		manager.stop();
		await vi.advanceTimersByTimeAsync(startRetryLongDelayMs);

		expect(FakeDetachedCloudflared.spawned).toHaveLength(1);
		expect(manager.getState()).toEqual({ status: 'stopped', url: null, error: null });
	});

	it('cancels a pending retry when a newer start begins', async () => {
		const manager = createManager();

		await manager.start(47821);
		FakeDetachedCloudflared.spawned[0].emitExit('dns timeout');
		await manager.start(47822);
		await vi.advanceTimersByTimeAsync(startRetryLongDelayMs);

		expect(FakeDetachedCloudflared.spawned).toHaveLength(2);
		expect(FakeDetachedCloudflared.starts.at(-1)?.origin).toBe('http://127.0.0.1:47822');
		expect(manager.getState().status).toBe('starting');
	});

	it('restarts a running tunnel that exits outside stop', async () => {
		const manager = createManager();

		await manager.start(47821);
		FakeDetachedCloudflared.spawned[0].emitUrl('https://table-tee-defines-customs.trycloudflare.com');
		FakeDetachedCloudflared.spawned[0].emitExit('Tunnel exited unexpectedly');

		expect(manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'Attempt 1 failed: Tunnel exited unexpectedly'
		});
		await vi.advanceTimersByTimeAsync(startRetryDelaysMs[0]);
		expect(FakeDetachedCloudflared.spawned).toHaveLength(2);
	});
});
