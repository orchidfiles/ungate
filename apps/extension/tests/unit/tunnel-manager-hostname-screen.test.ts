import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		killMock: vi.fn(),
		runtimeReadMock: vi.fn<
			() => {
				clients: object;
				tunnelProvider: string;
				ngrokDomain: null;
				tunnel: { url: string | null; pid: number | null; metricsPort: number | null };
			}
		>(),
		isRunningCommandMock: vi.fn<(pid: number, port: number | null) => boolean>(() => false),
		persisted: [] as { url: string | null; warning: string | null }[]
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
			mutate: vi.fn((mutator: (state: { tunnel: { url: string | null; warning: string | null } }) => unknown) => {
				const state = { tunnel: { url: null, warning: null } };
				mutator(state);
				mocks.persisted.push({ url: state.tunnel.url, warning: state.tunnel.warning });

				return Promise.resolve(state);
			}),
			read: () => mocks.runtimeReadMock(),
			hasLiveClients: vi.fn(() => true)
		}
	};
});

import { config } from '../../src/runtime-state/config';
import { TunnelManager } from '../../src/tunnel-manager';

import { FakeDetachedCloudflared } from './helpers/fake-detached-cloudflared';

import type { LogEntry, TunnelState } from '@ungate/shared/frontend';

const REJECTED_URL = 'https://table-stupid-range-seeds.trycloudflare.com';
const SECOND_REJECTED_URL = 'https://acre-idiot-case-shaw.trycloudflare.com';
const CLEAN_URL = 'https://table-tee-defines-customs.trycloudflare.com';
const REJECTED_WORDS = /stupid|idiot/;

interface Harness {
	manager: TunnelManager;
	states: TunnelState[];
	logs: LogEntry[];
	tunnels: FakeDetachedCloudflared[];
}

function createHarness(): Harness {
	const states: TunnelState[] = [];
	const logs: LogEntry[] = [];
	FakeDetachedCloudflared.reset();

	const manager = new TunnelManager(
		'window-a',
		() => true,
		(state) => {
			states.push(state);
		},
		(entry) => {
			logs.push(entry);
		}
	);

	return { manager, states, logs, tunnels: FakeDetachedCloudflared.spawned };
}

function publish(tunnel: FakeDetachedCloudflared, url: string, urlFirst = true): void {
	const banner = `2026-11-23T00:00:00Z INF |  ${url}  |`;

	if (urlFirst) {
		tunnel.emitUrl(url);
		tunnel.emitLog(banner);

		return;
	}

	tunnel.emitLog(banner);
	tunnel.emitUrl(url);
}

function everythingPublished(harness: Harness): string {
	return JSON.stringify([harness.states, harness.logs, mocks.persisted, harness.manager.getState()]);
}

describe('TunnelManager quick tunnel hostname screening', () => {
	const { hostnameMaxAttempts, hostnameRerollDelayMs } = config.tunnelManager;

	beforeEach(() => {
		vi.useFakeTimers();
		mocks.persisted.length = 0;
		mocks.killMock.mockReset();
		mocks.isRunningCommandMock.mockReset();
		mocks.isRunningCommandMock.mockReturnValue(false);
		FakeDetachedCloudflared.reset();
		mocks.runtimeReadMock.mockReset();
		mocks.runtimeReadMock.mockReturnValue({
			clients: {},
			tunnelProvider: 'quick',
			ngrokDomain: null,
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

	it('uses a cap of 5 attempts with a delay between them', () => {
		expect(hostnameMaxAttempts).toBe(5);
		expect(hostnameRerollDelayMs).toBeGreaterThan(0);
	});

	it('publishes an accepted hostname right away', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		harness.tunnels[0].emitUrl(CLEAN_URL);
		await vi.advanceTimersByTimeAsync(0);

		expect(harness.manager.getState()).toEqual({ status: 'running', url: CLEAN_URL, error: null });
		expect(harness.tunnels).toHaveLength(1);
		expect(harness.logs.map((entry) => entry.message)).toContain(`Tunnel URL: ${CLEAN_URL}`);
	});

	it.each([
		{ order: 'url before stderr', urlFirst: true },
		{ order: 'stderr before url', urlFirst: false }
	])('rerolls a rejected hostname without publishing it ($order)', async ({ urlFirst }) => {
		const harness = createHarness();

		await harness.manager.start(47821);
		publish(harness.tunnels[0], REJECTED_URL, urlFirst);

		expect(harness.tunnels[0].stopped).toBe(1);
		expect(harness.manager.getState().status).toBe('starting');
		expect(harness.tunnels).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(hostnameRerollDelayMs - 1);
		expect(harness.tunnels).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(harness.tunnels).toHaveLength(2);

		publish(harness.tunnels[1], CLEAN_URL, urlFirst);
		await vi.advanceTimersByTimeAsync(0);

		expect(harness.manager.getState()).toEqual({ status: 'running', url: CLEAN_URL, error: null });
		expect(harness.logs.map((entry) => entry.message)).toContain(
			'Tunnel hostname rejected by the word filter, requesting another (attempt 2 of 5)'
		);
		expect(everythingPublished(harness)).not.toMatch(REJECTED_WORDS);
	});

	it('ignores late output and the exit of a rejected process', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		const rejected = harness.tunnels[0];
		rejected.emitUrl(REJECTED_URL);
		rejected.emitLog(`ERR request failed dest=${REJECTED_URL}/v1/models`);
		rejected.emitUrl(REJECTED_URL);
		rejected.emitLog(`late failure for ${REJECTED_URL}`);
		rejected.emitExit('late exit');

		expect(rejected.stopped).toBe(1);
		expect(harness.manager.getState().status).toBe('starting');

		await vi.advanceTimersByTimeAsync(hostnameRerollDelayMs);

		expect(harness.tunnels).toHaveLength(2);
		expect(everythingPublished(harness)).not.toMatch(REJECTED_WORDS);
	});

	it('redacts a rejected hostname that shows up in the output of an accepted tunnel', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		harness.tunnels[0].emitLog(`INF previous tunnel ${REJECTED_URL} closed`);

		expect(harness.logs.map((entry) => entry.message)).toEqual([
			'INF previous tunnel https://hidden-hostname.trycloudflare.com closed'
		]);
	});

	it('gives up after 5 rejected hostnames without naming them', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);

		for (let attempt = 1; attempt <= hostnameMaxAttempts; attempt++) {
			expect(harness.tunnels).toHaveLength(attempt);
			harness.tunnels[attempt - 1].emitUrl(attempt % 2 === 0 ? SECOND_REJECTED_URL : REJECTED_URL);
			await vi.advanceTimersByTimeAsync(hostnameRerollDelayMs);
		}

		await vi.advanceTimersByTimeAsync(hostnameRerollDelayMs * 10);

		expect(harness.tunnels).toHaveLength(hostnameMaxAttempts);
		expect(harness.tunnels.every((tunnel) => tunnel.stopped === 1)).toBe(true);
		expect(harness.manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'Cloudflare assigned a hostname rejected by the word filter 5 times in a row. Start the tunnel again to retry.'
		});
		expect(everythingPublished(harness)).not.toMatch(REJECTED_WORDS);
	});

	it('cancels a pending reroll when the tunnel is stopped', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		harness.tunnels[0].emitUrl(REJECTED_URL);
		harness.manager.stop();

		await vi.advanceTimersByTimeAsync(hostnameRerollDelayMs * 10);

		expect(harness.tunnels).toHaveLength(1);
		expect(harness.manager.getState()).toEqual({ status: 'stopped', url: null, error: null });
	});

	it('lets a newer start replace a pending reroll instead of spawning twice', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		harness.tunnels[0].emitUrl(REJECTED_URL);
		await harness.manager.start(47822);

		expect(harness.tunnels).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(hostnameRerollDelayMs * 10);

		expect(harness.tunnels).toHaveLength(2);
		expect(FakeDetachedCloudflared.starts.at(-1)?.origin).toBe('http://127.0.0.1:47822');
	});

	it('does not report a deliberate stop during startup as a failed start', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		const tunnel = harness.tunnels[0];
		harness.manager.stop();
		tunnel.emitExit('stopped');

		expect(harness.manager.getState()).toEqual({ status: 'stopped', url: null, error: null });
		expect(harness.logs.map((entry) => entry.message).join('\n')).not.toContain('Tunnel exited');
	});

	it('still reports a process that dies before the tunnel is ready', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		harness.tunnels[0].emitExit();

		expect(harness.manager.getState()).toEqual({
			status: 'error',
			url: null,
			error: 'Attempt 1 failed: Process exited before tunnel was ready'
		});
	});

	it('does not treat the quick-tunnel API address as the tunnel URL', async () => {
		const harness = createHarness();

		await harness.manager.start(47821);
		harness.tunnels[0].emitUrl('https://api.trycloudflare.com');

		expect(harness.manager.getState().status).toBe('starting');
	});

	it('refuses to adopt a running tunnel whose recorded hostname is rejected', async () => {
		const harness = createHarness();
		mocks.isRunningCommandMock.mockReturnValue(true);
		FakeDetachedCloudflared.reportedHostname = 'table-stupid-range-seeds.trycloudflare.com';
		mocks.runtimeReadMock.mockReturnValue({
			clients: {},
			tunnelProvider: 'quick',
			ngrokDomain: null,
			tunnel: { url: REJECTED_URL, pid: 42, metricsPort: 45000 }
		});

		await harness.manager.start(47821);

		expect(mocks.killMock).toHaveBeenCalledWith(42);
		expect(harness.tunnels).toHaveLength(1);
		expect(harness.manager.getState().status).toBe('starting');

		harness.tunnels[0].emitUrl(CLEAN_URL);
		await vi.advanceTimersByTimeAsync(0);

		expect(harness.manager.getState()).toEqual({ status: 'running', url: CLEAN_URL, error: null });
		expect(everythingPublished(harness)).not.toMatch(REJECTED_WORDS);
	});
});
