import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { CloudflaredProcess } from './runtime-state/cloudflared-process';
import { config } from './runtime-state/config';

export interface DetachedCloudflaredExit {
	reason: string;
}

export interface DetachedCloudflaredListener {
	onLog(line: string): void;
	onUrl(url: string): void;
	onExit(exit: DetachedCloudflaredExit): void;
}

export interface DetachedCloudflaredSpawn {
	binaryPath: string;
	origin: string;
	originPort: number;
	configArg: string;
	logPath: string;
	metricsPort?: number;
}

export interface DetachedCloudflaredAttach {
	pid: number;
	metricsPort: number;
	originPort: number;
	logPath: string;
}

interface QuickTunnelBody {
	hostname: string;
}

export class DetachedCloudflared {
	private currentPid: number | null = null;
	private currentMetricsPort: number | null = null;
	private originPort: number | null = null;
	private logPath: string | null = null;
	private logOffset = 0;
	private logRemainder = '';
	private urlPublished = false;
	private closed = false;
	private urlTimer: NodeJS.Timeout | null = null;
	private logTimer: NodeJS.Timeout | null = null;
	private livenessTimer: NodeJS.Timeout | null = null;
	private urlPollStartedAt = 0;

	constructor(private readonly listener: DetachedCloudflaredListener) {}

	public getPid(): number | null {
		return this.currentPid;
	}

	public getMetricsPort(): number | null {
		return this.currentMetricsPort;
	}

	public async start(spec: DetachedCloudflaredSpawn): Promise<void> {
		let metricsPort = spec.metricsPort;
		metricsPort ??= await this.reserveLoopbackPort();

		this.currentMetricsPort = metricsPort;
		this.originPort = spec.originPort;
		this.logPath = spec.logPath;
		this.prepareLog(spec.logPath);
		this.spawnProcess(spec, metricsPort);

		if (this.closed) {
			return;
		}

		this.followLog();
		this.watchLiveness();
		this.watchUrl();
	}

	public attach(spec: DetachedCloudflaredAttach): void {
		this.currentPid = spec.pid;
		this.currentMetricsPort = spec.metricsPort;
		this.originPort = spec.originPort;
		this.logPath = spec.logPath;
		this.logOffset = this.fileSize(spec.logPath);
		this.followLog();
		this.watchLiveness();
	}

	public stop(): void {
		if (this.closed) {
			this.killPid();

			return;
		}

		this.closed = true;
		this.clearTimers();
		this.killPid();
	}

	public async readQuickTunnelHostname(metricsPort: number, attempts = 1): Promise<string | null> {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const hostname = await this.readQuickTunnelHostnameOnce(metricsPort);

			if (hostname) {
				return hostname;
			}

			if (attempt + 1 < attempts) {
				await this.delay(config.tunnelManager.quickTunnelPollIntervalMs);
			}
		}

		return null;
	}

	public hostnameMatches(recordedUrl: string, reportedHostname: string): boolean {
		const recorded = this.hostnameOf(recordedUrl);
		const reported = this.hostnameOf(reportedHostname);

		if (!recorded || !reported) {
			return false;
		}

		return recorded === reported;
	}

	private spawnProcess(spec: DetachedCloudflaredSpawn, metricsPort: number): void {
		let child: cp.ChildProcess;

		try {
			child = cp.spawn(
				spec.binaryPath,
				[
					'tunnel',
					'--url',
					spec.origin,
					'--config',
					spec.configArg,
					'--edge-ip-version',
					'4',
					'--metrics',
					`127.0.0.1:${metricsPort}`,
					'--logfile',
					spec.logPath
				],
				{ detached: true, stdio: 'ignore' }
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.fail(`Failed to start cloudflared: ${message}`);

			return;
		}

		child.unref();
		child.on('error', (error: Error) => {
			this.fail(`Failed to start cloudflared: ${error.message}`);
		});

		if (child.pid == null) {
			this.fail('Failed to start cloudflared: no pid');

			return;
		}

		this.currentPid = child.pid;
	}

	private prepareLog(logPath: string): void {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, '');
		this.logOffset = 0;
		this.logRemainder = '';
	}

	private followLog(): void {
		this.readNewLog();
		this.logTimer = setInterval(() => {
			this.readNewLog();
		}, config.tunnelManager.logFollowIntervalMs);
	}

	private watchLiveness(): void {
		this.livenessTimer = setInterval(() => {
			this.checkLiveness();
		}, config.tunnelManager.livenessIntervalMs);
	}

	private watchUrl(): void {
		this.urlPollStartedAt = Date.now();
		this.pollUrl();
		this.urlTimer = setInterval(() => {
			this.pollUrl();
		}, config.tunnelManager.quickTunnelPollIntervalMs);
	}

	private pollUrl(): void {
		if (this.closed || this.urlPublished || this.currentMetricsPort == null) {
			return;
		}

		if (Date.now() - this.urlPollStartedAt >= config.tunnelManager.quickTunnelReadyTimeoutMs) {
			this.fail('Timed out waiting for the quick tunnel URL');

			return;
		}

		const metricsPort = this.currentMetricsPort;

		void this.readQuickTunnelHostnameOnce(metricsPort).then((hostname) => {
			if (this.closed || this.urlPublished || !hostname) {
				return;
			}

			const url = this.urlForHostname(hostname);

			if (this.hostnameOf(url) === 'api.trycloudflare.com') {
				return;
			}

			this.urlPublished = true;

			if (this.urlTimer) {
				clearInterval(this.urlTimer);
				this.urlTimer = null;
			}

			this.listener.onUrl(url);
		});
	}

	private checkLiveness(): void {
		if (this.closed) {
			return;
		}

		if (this.processIsAlive()) {
			return;
		}

		const reason = this.urlPublished ? 'Tunnel exited unexpectedly' : 'Process exited before tunnel was ready';
		this.fail(reason);
	}

	private processIsAlive(): boolean {
		if (this.currentPid == null || this.originPort == null) {
			return false;
		}

		try {
			process.kill(this.currentPid, 0);
		} catch (error) {
			if (!this.isEperm(error)) {
				return false;
			}
		}

		return CloudflaredProcess.isRunningCommand(this.currentPid, this.originPort);
	}

	private readNewLog(): void {
		if (this.closed || !this.logPath) {
			return;
		}

		let size: number;

		try {
			size = fs.statSync(this.logPath).size;
		} catch {
			return;
		}

		if (size < this.logOffset) {
			this.logOffset = 0;
			this.logRemainder = '';
		}

		if (size === this.logOffset) {
			return;
		}

		let fd: number | null = null;

		try {
			fd = fs.openSync(this.logPath, 'r');
			const length = size - this.logOffset;
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, this.logOffset);
			this.logOffset = size;
			this.emitLogText(buffer.toString('utf8'));
		} catch {
			return;
		} finally {
			if (fd != null) {
				fs.closeSync(fd);
			}
		}
	}

	private emitLogText(chunk: string): void {
		const text = this.logRemainder + chunk;
		const lines = text.split('\n');
		this.logRemainder = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim() || this.closed) {
				continue;
			}

			this.listener.onLog(line);
		}
	}

	private async readQuickTunnelHostnameOnce(metricsPort: number): Promise<string | null> {
		try {
			const response = await fetch(`http://127.0.0.1:${metricsPort}/quicktunnel`, {
				signal: AbortSignal.timeout(config.tunnelManager.quickTunnelProbeTimeoutMs)
			});

			if (!response.ok) {
				return null;
			}

			const body: unknown = await response.json();

			if (!this.isQuickTunnelBody(body)) {
				return null;
			}

			const hostname = body.hostname.trim();

			if (!hostname) {
				return null;
			}

			return hostname;
		} catch {
			return null;
		}
	}

	private isQuickTunnelBody(body: unknown): body is QuickTunnelBody {
		if (typeof body !== 'object' || body === null || !('hostname' in body)) {
			return false;
		}

		return typeof body.hostname === 'string';
	}

	private urlForHostname(hostname: string): string {
		if (hostname.includes('://')) {
			return hostname;
		}

		return `https://${hostname}`;
	}

	private hostnameOf(value: string): string | null {
		const trimmed = value.trim();

		if (!trimmed) {
			return null;
		}

		try {
			const hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;

			return hostname.toLowerCase() || null;
		} catch {
			return null;
		}
	}

	private fail(reason: string): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.clearTimers();
		this.killPid();
		this.listener.onExit({ reason });
	}

	private killPid(): void {
		if (this.currentPid == null) {
			return;
		}

		try {
			process.kill(this.currentPid);
		} catch {
			// The process already exited.
		}
	}

	private clearTimers(): void {
		if (this.urlTimer) {
			clearInterval(this.urlTimer);
			this.urlTimer = null;
		}

		if (this.logTimer) {
			clearInterval(this.logTimer);
			this.logTimer = null;
		}

		if (this.livenessTimer) {
			clearInterval(this.livenessTimer);
			this.livenessTimer = null;
		}
	}

	private fileSize(logPath: string): number {
		try {
			return fs.statSync(logPath).size;
		} catch {
			return 0;
		}
	}

	private reserveLoopbackPort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = net.createServer();

			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				const port = typeof address === 'object' && address ? address.port : 0;

				server.close((error) => {
					if (error) {
						reject(error);

						return;
					}

					if (port <= 0) {
						reject(new Error('Could not reserve a metrics port'));

						return;
					}

					resolve(port);
				});
			});
		});
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}

	private isEperm(error: unknown): boolean {
		return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
	}
}
