import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import { sleep, type ApiStatus as ServerStatus, type LogEntry } from '@ungate/shared';
import * as vscode from 'vscode';

import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { BetterSqlite3Installer } from './utils/better-sqlite3-installer';
import { NodeResolver } from './utils/node-resolver';

const HEALTH_CHECK_URL = (port: number) => `http://localhost:${port}/health`;
const STARTING_STATE_TIMEOUT_MS = 10000;

interface ApiServerCallbacks {
	onLog(level: LogEntry['level'], message: string): void;
	onPortDetected(port: number): void;
	onStatusChange(status: ServerStatus): void;
	isLeaderWindow(): boolean;
	isExtensionHostActive(): boolean;
	getWindowId(): string;
}

export class ApiServer {
	private process: cp.ChildProcess | null = null;
	private healthCheckTimer: NodeJS.Timeout | null = null;
	private stdoutBuffer = '';
	private restartRequested = false;
	private shutDownDeliberately = false;
	private lastStatus: ServerStatus | null = null;
	private port: number | null = null;
	private runtimePath = '';
	private noClientsSince: number | null = null;
	private addressInUsePort: number | null = null;
	private startPromise: Promise<void> | null = null;
	private restartInProgress = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly callbacks: ApiServerCallbacks
	) {}

	async start(): Promise<void> {
		if (this.isAutoStartBlocked()) {
			return;
		}

		if (this.process) {
			return;
		}

		if (this.startPromise) {
			return this.startPromise;
		}

		this.startPromise = this.doStart();

		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	isStartupInProgress(): boolean {
		return this.startPromise !== null;
	}

	async restart(): Promise<void> {
		this.restartInProgress = true;
		this.port = null;
		await RuntimeStateStore.resetApiForRestart();
		this.restartRequested = true;
		await this.setStatus('stopped');

		if (!this.process) {
			try {
				await this.start();
			} finally {
				this.restartInProgress = false;
				this.restartRequested = false;
			}

			return;
		}

		this.process.kill();
	}

	async stop(): Promise<void> {
		this.stopHealthCheck();
		if (this.process) {
			this.shutDownDeliberately = true;
		}
		this.process?.kill();
		this.process = null;
		this.noClientsSince = null;

		if (RuntimeStateStore.isApiStartSuppressed()) {
			this.lastStatus = 'error';

			return;
		}

		this.lastStatus = 'stopped';
		await this.writeRuntimeState('stopped', null);
	}

	getPort(): number | null {
		return this.port;
	}

	syncLeaderHealthMonitor(isLeader: boolean): void {
		if (!isLeader) {
			this.stopHealthCheck();

			return;
		}

		const hasRuntimeTarget = this.process !== null || this.port !== null || this.startPromise !== null;

		if (hasRuntimeTarget && !this.healthCheckTimer) {
			this.startHealthCheck();
		}
	}

	private async doStart(): Promise<void> {
		if (this.isAutoStartBlocked()) {
			return;
		}

		const runtimeState = RuntimeStateStore.read();
		const existingPort = runtimeState.api.port;

		if (existingPort) {
			const isAlive = await this.checkPortHealth(existingPort);

			if (isAlive) {
				this.port = existingPort;
				this.callbacks.onPortDetected(existingPort);
				await this.setStatus('running');
				this.startHealthCheck();

				return;
			}
		}

		if (runtimeState.api.status === 'starting' && runtimeState.api.ownerWindowId !== this.callbacks.getWindowId()) {
			const startingStateAge = Date.now() - runtimeState.api.lastSeenAt;

			if (startingStateAge < STARTING_STATE_TIMEOUT_MS) {
				return;
			}
		}

		await this.setStatus('starting');

		try {
			await this.ensureNativeDeps();
			this.spawn();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			await this.recordApiFailure(message);
			throw err;
		}
	}

	private isAutoStartBlocked(): boolean {
		if (this.restartInProgress) {
			return false;
		}

		return RuntimeStateStore.isApiStartSuppressed();
	}

	private async recordApiFailure(message: string): Promise<void> {
		this.lastStatus = 'error';
		await RuntimeStateStore.suppressApiAutoStart(message);
		this.callbacks.onStatusChange('error');
	}

	private spawn(): void {
		if (!this.callbacks.isLeaderWindow() || !this.callbacks.isExtensionHostActive()) {
			return;
		}

		const cwd = this.getServerCwd();
		this.stdoutBuffer = '';

		const isDev = this.context.extensionMode === vscode.ExtensionMode.Development;
		const runtime = this.runtimePath || this.resolveRuntimePath(NodeResolver.resolve(process.env.UNGATE_NODE_BIN));
		this.runtimePath = runtime;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			UNGATE_BETTER_SQLITE3_NATIVE_BINDING: BetterSqlite3Installer.resolveBindingPath(cwd),
			...(isDev ? { DB_PATH: path.join(os.homedir(), '.ungate', 'data-dev.db') } : { DRIZZLE_PATH: path.join(cwd, 'drizzle') })
		};

		const nodeArgs = isDev ? ['-r', 'source-map-support/register', 'dist/main.js'] : ['bundle/main.cjs'];

		this.callbacks.onLog('info', `[process] starting api via ${runtime}`);

		this.process = cp.spawn(runtime, nodeArgs, { cwd, env, stdio: 'pipe', detached: true });
		this.process.unref();
		void this.writeRuntimeState('starting', null).catch(() => {});

		this.process.stdout?.on('data', (data: Buffer) => this.onStdout(data));
		this.process.stderr?.on('data', (data: Buffer) => this.onStderr(data));
		this.process.on('exit', (code, signal) => this.onExit(code, signal));
		this.process.on('error', (err) => {
			void this.onSpawnProcessError(err).catch(() => {});
		});

		this.startHealthCheck();
	}

	private onStdout(data: Buffer): void {
		const text = data.toString();
		this.stdoutBuffer += text;

		for (const line of text.split('\n').filter((l) => l.trim())) {
			this.callbacks.onLog(this.parseLogLevel(line), line);
		}

		const match = /localhost:(\d+)/.exec(this.stdoutBuffer);

		if (match) {
			const port = parseInt(match[1], 10);

			if (port !== this.port) {
				this.port = port;
				this.callbacks.onPortDetected(port);
			}
		}
	}

	private onStderr(data: Buffer): void {
		const text = data.toString();

		for (const line of text.split('\n').filter((l) => l.trim())) {
			if (line.includes('EADDRINUSE')) {
				const match = /port:\s*(\d+)/.exec(this.stdoutBuffer + text);

				if (match) {
					this.addressInUsePort = parseInt(match[1], 10);
				}
			}

			this.callbacks.onLog('error', line);
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.process = null;
		this.noClientsSince = null;

		let level: LogEntry['level'];

		if (this.restartRequested || code === 0) {
			level = 'info';
		} else {
			level = 'error';
		}

		this.callbacks.onLog(level, `[process] exit code=${code} signal=${signal}`);

		if (this.restartRequested) {
			this.shutDownDeliberately = false;
			this.lastStatus = 'stopped';
			void sleep(config.apiServer.restartDelayMs).then(async () => {
				if (!this.shouldRespawn()) {
					this.restartInProgress = false;
					this.restartRequested = false;

					return;
				}

				try {
					await this.start();
				} finally {
					this.restartInProgress = false;
					this.restartRequested = false;
				}
			});

			return;
		}

		if (this.shutDownDeliberately) {
			this.shutDownDeliberately = false;

			return;
		}

		if (code === 0) {
			this.lastStatus = 'stopped';
			void sleep(config.apiServer.restartDelayMs).then(() => {
				if (!this.shouldRespawn()) {
					return;
				}

				this.spawn();
			});

			return;
		}

		if (this.addressInUsePort) {
			const addressInUsePort = this.addressInUsePort;
			this.addressInUsePort = null;
			void this.tryAttachToRunningPort(addressInUsePort).catch(() => {});

			return;
		}

		const message = `[process] exit code=${code} signal=${signal}`;

		void this.recordApiFailure(message).catch(() => {});
	}

	private shouldRespawn(): boolean {
		if (!this.restartInProgress && this.isAutoStartBlocked()) {
			return false;
		}

		return this.callbacks.isLeaderWindow() && this.callbacks.isExtensionHostActive();
	}

	private async tryAttachToRunningPort(port: number): Promise<void> {
		const isAlive = await this.checkPortHealth(port);

		if (!isAlive) {
			await this.recordApiFailure(`[process] port ${port} is not healthy`);

			return;
		}

		this.port = port;
		this.callbacks.onPortDetected(port);
		await this.setStatus('running');
		this.startHealthCheck();
	}

	private async onSpawnProcessError(err: Error): Promise<void> {
		this.callbacks.onLog('error', `[process] error: ${err.message}`);
		await this.recordApiFailure(err.message);
	}

	private startHealthCheck(): void {
		this.stopHealthCheck();

		this.healthCheckTimer = setInterval(() => {
			void this.runHealthCheckCycle().catch(() => {});
		}, config.apiServer.healthCheckIntervalMs);
	}

	private async runHealthCheckCycle(): Promise<void> {
		if (!this.callbacks.isLeaderWindow()) {
			return;
		}

		const runtimeState = RuntimeStateStore.read();
		const hasLiveClientsOnDisk = RuntimeStateStore.hasLiveClients(runtimeState);
		const extensionHostAlive = this.callbacks.isExtensionHostActive();
		const treatAsLiveClients = hasLiveClientsOnDisk || extensionHostAlive;
		const hasLeaderWindow = this.callbacks.isLeaderWindow();

		if (!treatAsLiveClients && this.lastStatus === 'running') {
			this.noClientsSince ??= Date.now();

			if (Date.now() - this.noClientsSince >= config.apiServer.noClientsGracePeriodMs) {
				this.callbacks.onLog('info', '[process] no live windows, stopping api');
				await this.stop();

				return;
			}
		} else {
			this.noClientsSince = null;
		}

		if (treatAsLiveClients && this.lastStatus === 'running' && !hasLeaderWindow) {
			return;
		}

		if (!this.port) {
			return;
		}

		try {
			const res = await fetch(HEALTH_CHECK_URL(this.port), {
				signal: AbortSignal.timeout(config.apiServer.healthCheckRequestTimeoutMs)
			});

			if (res.ok) {
				const wasDown = this.lastStatus !== 'running';

				await this.setStatus('running');

				if (wasDown) {
					this.callbacks.onPortDetected(this.port);
				}
			} else {
				await this.recordApiFailure(`[process] health check failed with status ${res.status}`);
			}
		} catch {
			await this.recordApiFailure('[process] health check failed');
		}
	}

	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	private async setStatus(status: ServerStatus): Promise<void> {
		this.lastStatus = status;
		await this.writeRuntimeState(status, null);
		this.callbacks.onStatusChange(status);
	}

	private async writeRuntimeState(status: ServerStatus, errorMessage: string | null): Promise<void> {
		await RuntimeStateStore.mutate((current) => {
			if (current.api.status === 'error' && status !== 'error' && status !== 'stopped') {
				return current;
			}

			const now = Date.now();
			let pid: number | null = null;

			if (this.process?.pid) {
				pid = this.process.pid;
			}

			current.api.pid = pid;
			current.api.port = this.port;
			current.api.status = status;
			current.api.lastSeenAt = now;
			current.api.lastError = errorMessage;

			if (status === 'starting') {
				current.api.ownerWindowId = this.callbacks.getWindowId();
			} else if (status === 'stopped' || status === 'error') {
				current.api.ownerWindowId = null;
			}

			return current;
		});
	}

	private async checkPortHealth(port: number): Promise<boolean> {
		try {
			const response = await fetch(HEALTH_CHECK_URL(port), {
				signal: AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs)
			});

			return response.ok;
		} catch {
			return false;
		}
	}

	private getServerCwd(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return path.join(this.context.extensionPath, '..', 'api');
		}

		return path.join(this.context.extensionPath, 'bundled', 'api');
	}

	private parseLogLevel(line: string): LogEntry['level'] {
		const lower = line.toLowerCase();

		if (lower.includes('error') || lower.includes('fatal')) {
			return 'error';
		}

		if (lower.includes('warn')) {
			return 'warn';
		}

		return 'info';
	}

	private async ensureNativeDeps(): Promise<void> {
		const apiDir = this.getServerCwd();
		const runtime = this.resolveRuntimePath(NodeResolver.resolve(process.env.UNGATE_NODE_BIN));
		this.runtimePath = runtime;

		await BetterSqlite3Installer.ensureInstalled(apiDir, runtime, {
			onLog: (level, message) => {
				this.callbacks.onLog(level, message);
			}
		});
	}

	private resolveRuntimePath(runtime: string): string {
		const inspected = cp.spawnSync(runtime, ['-p', 'process.execPath'], { encoding: 'utf8' });

		if (inspected.error || inspected.status !== 0) {
			return runtime;
		}

		const absolutePath = inspected.stdout.trim();

		if (!absolutePath) {
			return runtime;
		}

		return absolutePath;
	}
}
