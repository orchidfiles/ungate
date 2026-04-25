import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bin, install, use, Tunnel } from 'cloudflared';

import type { LogEntry } from './utils/log-ring-buffer';

export type TunnelStatus = 'stopped' | 'installing' | 'starting' | 'running' | 'error';

export interface TunnelState {
	status: TunnelStatus;
	url: string | null;
	error: string | null;
}

const CLOUDFLARED_BIN_DIR = path.join(os.homedir(), '.ungate', 'bin');
const CLOUDFLARED_BIN_PATH = path.join(CLOUDFLARED_BIN_DIR, 'cloudflared');

export class TunnelManager {
	private tunnel: Tunnel | null = null;
	private state: TunnelState = { status: 'stopped', url: null, error: null };

	constructor(
		private readonly onStateChange: (state: TunnelState) => void,
		private readonly onLog: (entry: LogEntry) => void
	) {}

	getState(): TunnelState {
		return { ...this.state };
	}

	async start(port: number): Promise<void> {
		if (this.state.status === 'running') {
			return;
		}

		if (this.tunnel) {
			this.tunnel.stop();
			this.tunnel = null;
		}

		this.setState({ status: 'starting', url: null, error: null });

		await this.ensureBinary();

		if (this.state.status === 'error') {
			return;
		}

		this.spawnTunnel(port);
	}

	stop(): void {
		if (this.tunnel) {
			this.tunnel.stop();
			this.tunnel = null;
		}

		this.setState({ status: 'stopped', url: null, error: null });
	}

	async restart(port: number): Promise<void> {
		this.stop();
		await this.start(port);
	}

	private async ensureBinary(): Promise<void> {
		const devBinExists = fs.existsSync(bin);
		const userBinExists = fs.existsSync(CLOUDFLARED_BIN_PATH);

		if (devBinExists) {
			return;
		}

		if (userBinExists) {
			use(CLOUDFLARED_BIN_PATH);

			return;
		}

		this.setState({ status: 'installing', url: null, error: null });
		this.onLog({ timestamp: Date.now(), level: 'info', message: 'Downloading cloudflared binary...' });

		try {
			fs.mkdirSync(CLOUDFLARED_BIN_DIR, { recursive: true });
			await install(CLOUDFLARED_BIN_PATH);
			use(CLOUDFLARED_BIN_PATH);
			this.onLog({ timestamp: Date.now(), level: 'info', message: 'cloudflared installed successfully' });
			this.setState({ status: 'starting', url: null, error: null });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.onLog({ timestamp: Date.now(), level: 'error', message: `Failed to install cloudflared: ${message}` });
			this.setState({ status: 'error', url: null, error: `Install failed: ${message}` });
		}
	}

	private spawnTunnel(port: number): void {
		const t = Tunnel.quick(`http://localhost:${port}`, {
			'--config': '/dev/null',
			'--edge-ip-version': '4'
		});
		this.tunnel = t;

		t.on('url', (url) => {
			this.onLog({ timestamp: Date.now(), level: 'info', message: `Tunnel URL: ${url}` });
			this.setState({ status: 'running', url, error: null });
		});

		t.on('stderr', (data) => {
			const lines = data.split('\n').filter((l) => l.trim());

			for (const line of lines) {
				this.onLog({ timestamp: Date.now(), level: 'info', message: line });
			}
		});

		t.on('error', (err) => {
			const message = err.message;
			this.onLog({ timestamp: Date.now(), level: 'error', message: `Tunnel error: ${message}` });
			this.setState({ status: 'error', url: null, error: message });
		});

		t.on('exit', (code, signal) => {
			this.onLog({ timestamp: Date.now(), level: 'warn', message: `Tunnel exited code=${code} signal=${signal}` });

			const wasStarting = this.state.status === 'starting';

			if (this.state.status !== 'stopped') {
				const next: TunnelState = wasStarting
					? { status: 'error', url: null, error: `Process exited before tunnel was ready (code=${code})` }
					: { status: 'stopped', url: null, error: null };

				this.setState(next);
			}

			this.tunnel = null;
		});
	}

	private setState(next: TunnelState): void {
		this.state = next;
		this.onStateChange(next);
	}
}
