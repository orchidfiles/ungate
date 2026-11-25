import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		spawnMock: vi.fn()
	};
});

vi.mock('node:child_process', () => {
	return {
		spawn: (...args: unknown[]) => mocks.spawnMock(...args)
	};
});

import { DetachedCloudflared } from '../../src/detached-cloudflared';
import { CloudflaredProcess } from '../../src/runtime-state/cloudflared-process';
import { config } from '../../src/runtime-state/config';

const FAKE_PID = 2_100_000_099;

function tempLog(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-cloudflared-'));

	return path.join(dir, 'cloudflared.log');
}

function fakeChild(): {
	child: EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };
	unref: ReturnType<typeof vi.fn>;
} {
	const unref = vi.fn();
	const child = new EventEmitter() as EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> };
	child.pid = FAKE_PID;
	child.unref = unref;

	return { child, unref };
}

describe('DetachedCloudflared', () => {
	const logs: string[] = [];
	const urls: string[] = [];
	const exits: string[] = [];
	let cloudflared: DetachedCloudflared | null = null;
	let logPath = '';

	function create(): DetachedCloudflared {
		logs.length = 0;
		urls.length = 0;
		exits.length = 0;
		cloudflared = new DetachedCloudflared({
			onLog(line) {
				logs.push(line);
			},
			onUrl(url) {
				urls.push(url);
			},
			onExit(exit) {
				exits.push(exit.reason);
			}
		});

		return cloudflared;
	}

	afterEach(() => {
		cloudflared?.stop();
		cloudflared = null;
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('spawns a detached process and reads the URL from the metrics endpoint', async () => {
		vi.useFakeTimers();
		logPath = tempLog();
		fs.writeFileSync(logPath, 'stale log\n');
		const { child, unref } = fakeChild();
		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(process, 'kill').mockImplementation(() => true);
		vi.spyOn(CloudflaredProcess, 'isRunningCommand').mockReturnValue(true);
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve({ ok: true, json: () => Promise.resolve({ hostname: 'table-tee-defines-customs.trycloudflare.com' }) })
			)
		);

		await create().start({
			binaryPath: '/tmp/cloudflared',
			origin: 'http://127.0.0.1:47821',
			originPort: 47821,
			configArg: '/dev/null',
			logPath,
			metricsPort: 45000
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(mocks.spawnMock).toHaveBeenCalledWith(
			'/tmp/cloudflared',
			[
				'tunnel',
				'--url',
				'http://127.0.0.1:47821',
				'--config',
				'/dev/null',
				'--edge-ip-version',
				'4',
				'--metrics',
				'127.0.0.1:45000',
				'--logfile',
				logPath
			],
			{ detached: true, stdio: 'ignore' }
		);
		expect(unref).toHaveBeenCalledOnce();
		expect(fs.readFileSync(logPath, 'utf8')).toBe('');
		expect(urls).toEqual(['https://table-tee-defines-customs.trycloudflare.com']);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:45000/quicktunnel',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
		child.emit('exit', 1, null);
		expect(exits).toEqual([]);
	});

	it('follows new log lines and does not treat them as the tunnel URL', async () => {
		vi.useFakeTimers();
		logPath = tempLog();
		const { child } = fakeChild();
		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(process, 'kill').mockImplementation(() => true);
		vi.spyOn(CloudflaredProcess, 'isRunningCommand').mockReturnValue(true);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false }))
		);

		await create().start({
			binaryPath: '/tmp/cloudflared',
			origin: 'http://127.0.0.1:47821',
			originPort: 47821,
			configArg: '/dev/null',
			logPath,
			metricsPort: 45000
		});
		fs.appendFileSync(logPath, 'partial');
		await vi.advanceTimersByTimeAsync(config.tunnelManager.logFollowIntervalMs);
		fs.appendFileSync(logPath, ` line https://table-stupid-range-seeds.trycloudflare.com\n`);
		await vi.advanceTimersByTimeAsync(config.tunnelManager.logFollowIntervalMs);

		expect(logs).toEqual(['partial line https://table-stupid-range-seeds.trycloudflare.com']);
		expect(urls).toEqual([]);
	});

	it('adopts a live pid and only reads log lines written after attach', async () => {
		vi.useFakeTimers();
		logPath = tempLog();
		fs.writeFileSync(logPath, 'already running\n');
		vi.spyOn(process, 'kill').mockImplementation(() => true);
		vi.spyOn(CloudflaredProcess, 'isRunningCommand').mockReturnValue(true);

		create().attach({ pid: FAKE_PID, metricsPort: 45000, originPort: 47821, logPath });
		await vi.advanceTimersByTimeAsync(config.tunnelManager.logFollowIntervalMs);
		fs.appendFileSync(logPath, 'still running\n');
		await vi.advanceTimersByTimeAsync(config.tunnelManager.logFollowIntervalMs);

		expect(logs).toEqual(['still running']);
		expect(urls).toEqual([]);
	});

	it('reports exit from a failed liveness check instead of the child exit event', async () => {
		vi.useFakeTimers();
		logPath = tempLog();
		const { child } = fakeChild();
		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(process, 'kill').mockImplementation(() => true);
		const alive = vi.spyOn(CloudflaredProcess, 'isRunningCommand').mockReturnValue(true);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false }))
		);

		await create().start({
			binaryPath: '/tmp/cloudflared',
			origin: 'http://127.0.0.1:47821',
			originPort: 47821,
			configArg: '/dev/null',
			logPath,
			metricsPort: 45000
		});
		child.emit('exit', 1, null);
		await vi.advanceTimersByTimeAsync(config.tunnelManager.livenessIntervalMs);
		expect(exits).toEqual([]);

		alive.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(config.tunnelManager.livenessIntervalMs);

		expect(exits).toEqual(['Process exited before tunnel was ready']);
	});

	it('stop kills by pid and does not report an exit', async () => {
		vi.useFakeTimers();
		logPath = tempLog();
		const { child } = fakeChild();
		mocks.spawnMock.mockReturnValue(child);
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		vi.spyOn(CloudflaredProcess, 'isRunningCommand').mockReturnValue(false);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false }))
		);
		const running = create();

		await running.start({
			binaryPath: '/tmp/cloudflared',
			origin: 'http://127.0.0.1:47821',
			originPort: 47821,
			configArg: '/dev/null',
			logPath,
			metricsPort: 45000
		});
		running.stop();
		await vi.advanceTimersByTimeAsync(config.tunnelManager.livenessIntervalMs * 3);

		expect(exits).toEqual([]);
		expect(kill).toHaveBeenCalledWith(FAKE_PID);
		expect(kill).not.toHaveBeenCalledWith(FAKE_PID, 0);
	});

	it('reserves a loopback metrics port when the caller does not supply one', async () => {
		logPath = tempLog();
		const { child } = fakeChild();
		mocks.spawnMock.mockReturnValue(child);
		vi.spyOn(process, 'kill').mockImplementation(() => true);
		vi.spyOn(CloudflaredProcess, 'isRunningCommand').mockReturnValue(true);
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: false }))
		);

		await create().start({
			binaryPath: '/tmp/cloudflared',
			origin: 'http://127.0.0.1:47821',
			originPort: 47821,
			configArg: '/dev/null',
			logPath
		});

		const args = mocks.spawnMock.mock.calls[0]?.[1] as string[];
		const metrics = args[args.indexOf('--metrics') + 1];

		expect(metrics).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(metrics).not.toBe('127.0.0.1:0');
	});

	it('compares a recorded URL with the quicktunnel hostname', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ hostname: 'kept.trycloudflare.com' }) }))
		);
		const probe = create();

		await expect(probe.readQuickTunnelHostname(45000)).resolves.toBe('kept.trycloudflare.com');
		expect(probe.hostnameMatches('https://kept.trycloudflare.com/', 'kept.trycloudflare.com')).toBe(true);
		expect(probe.hostnameMatches('https://kept.trycloudflare.com', 'other.trycloudflare.com')).toBe(false);
		expect(fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:45000/quicktunnel',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});
});
