import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { NodeResolver } from './utils/node-resolver';

import type { LogEntry } from './utils/log-ring-buffer';
import type { Writable } from 'node:stream';

const HEALTH_CHECK_INTERVAL_MS = 1000;
const HEALTH_CHECK_URL = (port: number) => `http://localhost:${port}/health`;
const BETTER_SQLITE3_VERSION = '11.9.1';

type ServerStatus = 'running' | 'stopped' | 'error';

interface ApiServerCallbacks {
	onLog(level: LogEntry['level'], message: string): void;
	onPortDetected(port: number): void;
	onStatusChange(status: ServerStatus): void;
}

export class ApiServer {
	private process: cp.ChildProcess | null = null;
	private healthCheckTimer: NodeJS.Timeout | null = null;
	private stdoutBuffer = '';
	private restartRequested = false;
	private lastStatus: ServerStatus | null = null;
	private port: number | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly callbacks: ApiServerCallbacks
	) {}

	async start(): Promise<void> {
		await this.ensureNativeDeps();
		this.spawn();
	}

	restart(): void {
		this.restartRequested = true;
		this.setStatus('stopped');

		if (!this.process) {
			setTimeout(() => this.spawn(), 0);

			return;
		}

		this.process.kill();
	}

	stop(): void {
		this.stopHealthCheck();
		this.process?.kill();
		this.process = null;
	}

	getPort(): number | null {
		return this.port;
	}

	private spawn(): void {
		const cwd = this.getServerCwd();
		this.stdoutBuffer = '';

		const isDev = this.context.extensionMode === vscode.ExtensionMode.Development;
		const runtime = isDev ? 'node' : NodeResolver.resolve(process.env.UNGATE_NODE_BIN);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			...(isDev ? { DB_PATH: path.join(os.homedir(), '.ungate', 'data-dev.db') } : { DRIZZLE_PATH: path.join(cwd, 'drizzle') })
		};

		const nodeArgs = isDev ? ['-r', 'source-map-support/register', 'dist/main.js'] : ['bundle/main.cjs'];

		this.callbacks.onLog('info', `[process] starting api via ${runtime}`);

		this.process = cp.spawn(runtime, nodeArgs, { cwd, env, stdio: 'pipe', detached: false });

		this.process.stdout?.on('data', (data: Buffer) => this.onStdout(data));
		this.process.stderr?.on('data', (data: Buffer) => this.onStderr(data));
		this.process.on('exit', (code, signal) => this.onExit(code, signal));
		this.process.on('error', (err) => this.onError(err));

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
			this.callbacks.onLog('error', line);
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		const level: LogEntry['level'] = this.restartRequested || code === 0 ? 'info' : 'error';
		this.callbacks.onLog(level, `[process] exit code=${code} signal=${signal}`);

		if (this.restartRequested || code === 0) {
			this.restartRequested = false;
			this.lastStatus = 'stopped';
			setTimeout(() => this.spawn(), 500);

			return;
		}

		this.setStatus('error');
	}

	private onError(err: Error): void {
		this.callbacks.onLog('error', `[process] error: ${err.message}`);
		this.setStatus('error');
	}

	private startHealthCheck(): void {
		this.stopHealthCheck();

		this.healthCheckTimer = setInterval(() => {
			if (!this.port) {
				return;
			}

			void fetch(HEALTH_CHECK_URL(this.port), { signal: AbortSignal.timeout(2000) })
				.then((res) => {
					if (res.ok) {
						const wasDown = this.lastStatus !== 'running';

						this.setStatus('running');

						if (wasDown) {
							this.callbacks.onPortDetected(this.port!);
						}
					} else {
						this.setStatus('error');
					}
				})
				.catch(() => {
					this.setStatus('stopped');
				});
		}, HEALTH_CHECK_INTERVAL_MS);
	}

	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	private setStatus(status: ServerStatus): void {
		this.lastStatus = status;
		this.callbacks.onStatusChange(status);
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
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return;
		}

		const sqliteDir = path.join(this.context.extensionPath, 'bundled', 'api', 'node_modules', 'better-sqlite3');
		const binaryPath = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');

		if (fs.existsSync(binaryPath)) {
			return;
		}

		const runtime = NodeResolver.resolve(process.env.UNGATE_NODE_BIN);
		const info = NodeResolver.inspect(runtime);
		const tarName = `better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${info.abi}-${info.platform}-${info.arch}.tar.gz`;
		const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}/${tarName}`;

		this.callbacks.onLog('info', `[native] Using runtime: ${runtime}`);
		this.callbacks.onLog('info', `[native] Downloading ${tarName}...`);

		await new Promise<void>((resolve, reject) => {
			const extract = cp.spawn('tar', ['xzf', '-', '-C', sqliteDir], { stdio: ['pipe', 'pipe', 'pipe'] });

			extract.stderr?.on('data', (data: Buffer) => {
				this.callbacks.onLog('error', `[native] tar: ${data.toString().trim()}`);
			});

			extract.on('exit', (code) => {
				if (code === 0) {
					this.callbacks.onLog('info', '[native] better-sqlite3 binary installed');
					resolve();
				} else {
					reject(new Error(`tar exited with code ${code}`));
				}
			});

			extract.on('error', reject);

			this.download(url, extract.stdin, reject);
		});
	}

	private download(targetUrl: string, dest: Writable | null, reject: (err: Error) => void): void {
		https
			.get(targetUrl, { headers: { 'User-Agent': 'ungate-extension' } }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					this.download(res.headers.location, dest, reject);

					return;
				}

				if (!res.statusCode || res.statusCode !== 200) {
					dest.destroy();
					reject(new Error(`Download failed: HTTP ${res.statusCode}`));

					return;
				}

				res.pipe(dest);
			})
			.on('error', (err: Error) => {
				dest.destroy();
				reject(err);
			});
	}
}
