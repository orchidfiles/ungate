import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { localApiBaseUrl, NgrokDomain } from '@ungate/shared';
import { bin, use, Tunnel } from 'cloudflared';

import { NgrokLogLine, type NgrokFailure } from './ngrok-log-line';
import { NgrokOutputLines } from './ngrok-output-lines';
import { NgrokTokenStore, UnavailableNgrokSecrets } from './ngrok-token-store';
import { CloudflaredProcess, RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { TunnelHostnameScreen } from './tunnel-hostname-screen';
import { CLOUDFLARED_VERSION, CloudflaredInstaller } from './utils/cloudflared-installer';
import { NGROK_VERSION, NgrokInstaller } from './utils/ngrok-installer';

import type { LogEntry, TunnelState } from '@ungate/shared/frontend';

const CLOUDFLARED_BIN_DIR = path.join(os.homedir(), '.ungate', 'bin');
const QUICK_TUNNEL_API_URL = 'https://api.trycloudflare.com';

interface NgrokProcess {
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	on(event: 'error', listener: (error: Error) => void): void;
	on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	kill(): void;
}

export class TunnelManager {
	private tunnel: Tunnel | null = null;
	private ngrok: NgrokProcess | null = null;
	private ngrokFailure: NgrokFailure | null = null;
	private adoptedPid: number | null = null;
	private state: TunnelState = { status: 'stopped', url: null, error: null };
	private readonly windowId: string;
	private autoStopTimer: NodeJS.Timeout | null = null;
	private hostnameRerollTimer: NodeJS.Timeout | null = null;
	/** Bumped by every start and stop; a start resuming after an await quits once it is stale. */
	private generation = 0;

	constructor(
		windowId: string,
		private readonly isExtensionHostActive: () => boolean,
		private readonly onStateChange: (state: TunnelState) => void,
		private readonly onLog: (entry: LogEntry) => void,
		private readonly ngrokToken: NgrokTokenStore = new NgrokTokenStore(new UnavailableNgrokSecrets())
	) {
		this.windowId = windowId;
	}

	getState(): TunnelState {
		return { ...this.state };
	}

	async start(port: number): Promise<void> {
		const generation = ++this.generation;

		if (this.state.status === 'running') {
			return;
		}

		if (this.adoptRunningTunnel(port)) {
			return;
		}

		this.stopProcesses();

		const provider = RuntimeStateStore.read().tunnelProvider;

		if (provider === 'ngrok') {
			await this.startNgrok(port, generation);

			return;
		}

		this.setState({ status: 'starting', url: null, error: null });

		await this.ensureBinary(generation);

		if (generation !== this.generation || this.state.status === 'error') {
			return;
		}

		this.spawnTunnel(port, generation, 1);
		this.scheduleAutoStop();
	}

	stop(): void {
		this.generation++;

		if (this.autoStopTimer) {
			clearInterval(this.autoStopTimer);
			this.autoStopTimer = null;
		}

		this.stopProcesses();
		this.setState({ status: 'stopped', url: null, error: null });
	}

	private stopProcesses(): void {
		if (this.hostnameRerollTimer) {
			clearTimeout(this.hostnameRerollTimer);
			this.hostnameRerollTimer = null;
		}

		if (this.tunnel) {
			this.tunnel.stop();
			this.tunnel = null;
		}

		if (this.ngrok) {
			this.ngrok.kill();
			this.ngrok = null;
		}

		this.stopAdoptedProcess();
	}

	/**
	 * A cloudflared process is already proxying this port and the shared state
	 * still has its public URL. Reuse that URL instead of requesting a new quick tunnel,
	 * unless its hostname fails the word filter: then the process is retired and replaced.
	 */
	private adoptRunningTunnel(port: number): boolean {
		const serving = CloudflaredProcess.findServing(port);
		const recordedUrl = RuntimeStateStore.read().tunnel?.url ?? null;

		if (!serving || !recordedUrl) {
			return false;
		}

		this.adoptedPid = serving.pid;

		if (!TunnelHostnameScreen.isAcceptable(recordedUrl)) {
			this.onLog({
				timestamp: Date.now(),
				level: 'warn',
				message: 'Running tunnel hostname rejected by the word filter, replacing it with a new tunnel'
			});

			return false;
		}

		this.onLog({ timestamp: Date.now(), level: 'info', message: `Tunnel URL: ${recordedUrl}` });
		this.setState({ status: 'running', url: recordedUrl, error: null });
		this.scheduleAutoStop();

		return true;
	}

	private stopAdoptedProcess(): void {
		if (this.adoptedPid == null) {
			return;
		}

		try {
			process.kill(this.adoptedPid);
		} catch {
			// The process already exited.
		}

		this.adoptedPid = null;
	}

	async restart(port: number): Promise<void> {
		this.stop();
		await this.start(port);
	}

	private async ensureBinary(generation: number): Promise<void> {
		if (fs.existsSync(bin)) {
			return;
		}

		const userBinPath = this.resolveUserBinaryPath();

		if (userBinPath) {
			use(userBinPath);

			return;
		}

		this.setState({ status: 'installing', url: null, error: null });
		this.onLog({ timestamp: Date.now(), level: 'info', message: `Downloading cloudflared ${CLOUDFLARED_VERSION}...` });

		try {
			const installedPath = await CloudflaredInstaller.install(this.getCloudflaredBinPath());

			use(installedPath);
			if (generation !== this.generation) return;
			this.onLog({
				timestamp: Date.now(),
				level: 'info',
				message: `cloudflared ${CLOUDFLARED_VERSION} installed and checksum-verified`
			});
			this.setState({ status: 'starting', url: null, error: null });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.onLog({ timestamp: Date.now(), level: 'error', message: `Failed to install cloudflared: ${message}` });
			if (generation !== this.generation) return;
			this.setState({ status: 'error', url: null, error: `Install failed: ${message}` });
		}
	}

	/**
	 * Returns a managed `~/.ungate/bin` binary only when it came from the pinned
	 * release. Binaries from an earlier unverified `latest` install are ignored so
	 * they get replaced by a checksum-verified one instead of being executed.
	 */
	private resolveUserBinaryPath(): string | null {
		const binPath = this.getCloudflaredBinPath();
		const legacyPath = this.getCloudflaredLegacyBinPath();

		if (process.platform === 'win32' && !fs.existsSync(binPath) && fs.existsSync(legacyPath)) {
			fs.renameSync(legacyPath, binPath);
		}

		if (CloudflaredInstaller.isPinnedInstall(binPath)) {
			return binPath;
		}

		return null;
	}

	private getCloudflaredBinPath(): string {
		if (process.platform === 'win32') {
			return path.join(CLOUDFLARED_BIN_DIR, 'cloudflared.exe');
		}

		return path.join(CLOUDFLARED_BIN_DIR, 'cloudflared');
	}

	private getCloudflaredLegacyBinPath(): string {
		return path.join(CLOUDFLARED_BIN_DIR, 'cloudflared');
	}

	private getCloudflaredConfigArg(): string {
		if (process.platform === 'win32') {
			return 'NUL';
		}

		return '/dev/null';
	}

	private getNgrokBinPath(): string {
		if (process.platform === 'win32') {
			return path.join(CLOUDFLARED_BIN_DIR, 'ngrok.exe');
		}

		return path.join(CLOUDFLARED_BIN_DIR, 'ngrok');
	}

	private async startNgrok(port: number, generation: number): Promise<void> {
		const token = await this.ngrokToken.read();

		if (generation !== this.generation) {
			return;
		}

		if (!token) {
			const error = 'Add an ngrok authtoken before starting the stable tunnel';
			this.onLog({ timestamp: Date.now(), level: 'error', message: error });
			this.setState({ status: 'error', url: null, error });

			return;
		}

		this.setState({ status: 'starting', url: null, error: null });

		const binaryPath = await this.ensureNgrokBinary(generation);

		if (!binaryPath || generation !== this.generation) {
			return;
		}

		const domain = NgrokDomain.normalize(RuntimeStateStore.read().ngrokDomain);
		const domainArgs = domain ? ['--url', `https://${domain}`] : [];
		const hostnameIsAssigned = domain === null;
		const child = cp.spawn(binaryPath, ['http', String(port), ...domainArgs, '--log', 'stdout', '--log-format', 'json'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, NGROK_AUTHTOKEN: token }
		});
		const stdoutLines = new NgrokOutputLines();
		const stderrLines = new NgrokOutputLines();
		this.ngrok = child;
		this.ngrokFailure = null;
		this.scheduleAutoStop();

		child.stdout?.on('data', (chunk: Buffer) => {
			if (this.ngrok !== child) return;
			this.consumeNgrokLines(stdoutLines.push(chunk.toString('utf8')), hostnameIsAssigned);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			if (this.ngrok !== child) return;
			this.consumeNgrokLines(stderrLines.push(chunk.toString('utf8')), hostnameIsAssigned);
		});
		child.on('error', (err) => {
			if (this.ngrok !== child) return;
			this.onLog({ timestamp: Date.now(), level: 'error', message: `Tunnel error: ${err.message}` });
			this.setState({ status: 'error', url: null, error: err.message });
		});
		child.on('exit', (code, signal) => {
			if (this.ngrok !== child) return;
			this.consumeNgrokLines([...stdoutLines.flush(), ...stderrLines.flush()], hostnameIsAssigned);
			this.onLog({ timestamp: Date.now(), level: 'warn', message: `Tunnel exited code=${code} signal=${signal}` });

			if (this.state.status !== 'stopped') {
				this.setState(this.ngrokExitState(code, hostnameIsAssigned));
			}

			this.ngrok = null;
		});
	}

	/** ngrok explains a failed exit in its own output; that reason is what the user needs to see. */
	private ngrokExitState(code: number | null, hostnameIsAssigned: boolean): TunnelState {
		const failure = this.ngrokFailure;

		if (failure && code !== 0) {
			const reason = failure.message ?? `ngrok exited (code=${code})`;
			const described = failure.code ? `${reason} (${failure.code})` : reason;
			const error = `ngrok: ${hostnameIsAssigned ? TunnelHostnameScreen.redact(described) : described}`;

			return { status: 'error', url: null, error };
		}

		if (this.state.status === 'starting') {
			return { status: 'error', url: null, error: `Process exited before tunnel was ready (code=${code})` };
		}

		return { status: 'stopped', url: null, error: null };
	}

	private rememberNgrokFailure(next: NgrokFailure): void {
		const current = this.ngrokFailure;

		if (!current || (next.code && next.message)) {
			this.ngrokFailure = next;

			return;
		}

		this.ngrokFailure = { code: current.code ?? next.code, message: current.message ?? next.message };
	}

	/**
	 * An ngrok dev domain is fixed per account and cannot be rerolled, so a rejected one keeps
	 * serving, but its URL is withheld: the state carries a warning instead of the URL and the
	 * log shows it redacted. A domain the user typed in is theirs to choose and is not screened.
	 */
	private consumeNgrokLines(lines: string[], hostnameIsAssigned: boolean): void {
		for (const line of lines) {
			const parsed = new NgrokLogLine(line);
			const message = hostnameIsAssigned ? TunnelHostnameScreen.redact(line) : line;
			this.onLog({ timestamp: Date.now(), level: parsed.level, message });

			if (parsed.failure) {
				this.rememberNgrokFailure(parsed.failure);
			}

			const url = parsed.tunnelUrl;

			if (!url || this.state.url === url) {
				continue;
			}

			if (hostnameIsAssigned && !TunnelHostnameScreen.isAcceptable(url)) {
				if (this.state.warning === 'offensive-hostname') {
					continue;
				}

				this.onLog({
					timestamp: Date.now(),
					level: 'warn',
					message:
						'Tunnel is running, but the hostname ngrok assigned was rejected by the word filter. It is hidden and will not be stored, copied or announced. Switch to the Quick tunnel or set your own ngrok domain.'
				});
				this.setState({ status: 'running', url: null, error: null, warning: 'offensive-hostname' });

				continue;
			}

			this.onLog({ timestamp: Date.now(), level: 'info', message: `Tunnel URL: ${url}` });
			this.setState({ status: 'running', url, error: null });
		}
	}

	private async ensureNgrokBinary(generation: number): Promise<string | null> {
		const binPath = this.getNgrokBinPath();

		if (NgrokInstaller.isPinnedInstall(binPath)) {
			return binPath;
		}

		this.setState({ status: 'installing', url: null, error: null });
		this.onLog({ timestamp: Date.now(), level: 'info', message: `Downloading ngrok ${NGROK_VERSION}...` });

		try {
			const installedPath = await NgrokInstaller.install(binPath);
			this.onLog({
				timestamp: Date.now(),
				level: 'info',
				message: `ngrok ${NGROK_VERSION} installed and checksum-verified`
			});
			if (generation !== this.generation) return null;
			this.setState({ status: 'starting', url: null, error: null });

			return installedPath;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.onLog({ timestamp: Date.now(), level: 'error', message: `Failed to install ngrok: ${message}` });
			if (generation !== this.generation) return null;
			this.setState({ status: 'error', url: null, error: `Install failed: ${message}` });

			return null;
		}
	}

	/**
	 * The quick-tunnel hostname is screened before anything is published. A rejected hostname
	 * never reaches the log or the state; its process is stopped and another tunnel is requested.
	 */
	private spawnTunnel(port: number, generation: number, attempt: number): void {
		const t = Tunnel.quick(localApiBaseUrl(port), {
			'--config': this.getCloudflaredConfigArg(),
			'--edge-ip-version': '4'
		});
		this.tunnel = t;

		t.on('url', (url) => {
			if (this.tunnel !== t || url === QUICK_TUNNEL_API_URL) return;

			if (!TunnelHostnameScreen.isAcceptable(url)) {
				this.tunnel = null;
				t.stop();
				this.rerollQuickTunnel(port, generation, attempt);

				return;
			}

			this.onLog({ timestamp: Date.now(), level: 'info', message: `Tunnel URL: ${url}` });
			this.setState({ status: 'running', url, error: null });
			this.scheduleAutoStop();
		});

		t.on('stderr', (data) => {
			if (this.tunnel !== t) return;

			const lines = data.split('\n').filter((line) => line.trim());

			for (const line of lines) {
				this.onLog({ timestamp: Date.now(), level: 'info', message: TunnelHostnameScreen.redact(line) });
			}
		});

		t.on('error', (err) => {
			if (this.tunnel !== t) return;

			const message = TunnelHostnameScreen.redact(err.message);
			this.onLog({ timestamp: Date.now(), level: 'error', message: `Tunnel error: ${message}` });
			this.setState({ status: 'error', url: null, error: message });
		});

		t.on('exit', (code, signal) => {
			if (this.tunnel !== t) return;

			this.onLog({ timestamp: Date.now(), level: 'warn', message: `Tunnel exited code=${code} signal=${signal}` });

			const wasStarting = this.state.status === 'starting';

			if (this.state.status !== 'stopped') {
				let next: TunnelState;

				if (wasStarting) {
					next = {
						status: 'error',
						url: null,
						error: `Process exited before tunnel was ready (code=${code})`
					};
				} else {
					next = { status: 'stopped', url: null, error: null };
				}

				this.setState(next);
			}

			this.tunnel = null;
		});
	}

	private rerollQuickTunnel(port: number, generation: number, attempt: number): void {
		const { hostnameMaxAttempts, hostnameRerollDelayMs } = config.tunnelManager;

		if (attempt >= hostnameMaxAttempts) {
			const error = `Cloudflare assigned a hostname rejected by the word filter ${hostnameMaxAttempts} times in a row. Start the tunnel again to retry.`;
			this.onLog({ timestamp: Date.now(), level: 'error', message: error });
			this.setState({ status: 'error', url: null, error });

			return;
		}

		const nextAttempt = attempt + 1;
		this.onLog({
			timestamp: Date.now(),
			level: 'warn',
			message: `Tunnel hostname rejected by the word filter, requesting another (attempt ${nextAttempt} of ${hostnameMaxAttempts})`
		});

		this.hostnameRerollTimer = setTimeout(() => {
			this.hostnameRerollTimer = null;

			if (generation !== this.generation) return;

			this.spawnTunnel(port, generation, nextAttempt);
		}, hostnameRerollDelayMs);
	}

	private setState(next: TunnelState): void {
		this.state = next;
		void this.persistTunnelState(next).catch(() => {});
	}

	private async persistTunnelState(next: TunnelState): Promise<void> {
		await RuntimeStateStore.mutate((current) => {
			current.tunnel.status = next.status;
			current.tunnel.url = next.url;
			current.tunnel.lastSeenAt = Date.now();
			current.tunnel.lastError = next.error;
			current.tunnel.warning = next.warning ?? null;
			current.tunnel.ownerWindowId = this.windowId;

			return current;
		});
		this.onStateChange(next);
	}

	private scheduleAutoStop(): void {
		if (this.autoStopTimer) {
			return;
		}

		this.autoStopTimer = setInterval(() => {
			const runtimeState = RuntimeStateStore.read();
			const hasLiveClientsOnDisk = RuntimeStateStore.hasLiveClients(runtimeState);

			if (!hasLiveClientsOnDisk && !this.isExtensionHostActive()) {
				this.stop();
			}
		}, config.tunnelManager.autoStopCheckIntervalMs);
	}
}
