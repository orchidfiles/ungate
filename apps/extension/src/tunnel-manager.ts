import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { localApiBaseUrl, NgrokDomain } from '@ungate/shared';
import { bin, use } from 'cloudflared';

import { DetachedCloudflared, type DetachedCloudflaredListener } from './detached-cloudflared';
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
	private cloudflared: DetachedCloudflared | null = null;
	private cloudflaredBinaryPath: string | null = null;
	private ngrok: NgrokProcess | null = null;
	private ngrokFailure: NgrokFailure | null = null;
	private adoptedPid: number | null = null;
	private state: TunnelState = { status: 'stopped', url: null, error: null };
	private readonly windowId: string;
	private autoStopTimer: NodeJS.Timeout | null = null;
	private hostnameRerollTimer: NodeJS.Timeout | null = null;
	private retryTimer: NodeJS.Timeout | null = null;
	private quickTunnelPort: number | null = null;
	private retryAttempt = 0;
	private attemptSaw429 = false;
	private attemptLogLine: string | null = null;
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
		if (this.state.status === 'running') {
			return;
		}

		const generation = ++this.generation;

		this.retryAttempt = 0;
		this.quickTunnelPort = port;
		this.clearRetryTimer();

		const adopted = await this.adoptRunningTunnel(port, generation);

		if (adopted) {
			return;
		}

		if (generation !== this.generation) {
			return;
		}

		this.stopProcesses();

		const provider = RuntimeStateStore.read().tunnelProvider;

		if (provider === 'ngrok') {
			await this.startNgrok(port, generation);

			return;
		}

		this.setState({ status: 'starting', url: null, error: null });

		const binaryPath = await this.ensureBinary(generation);

		if (!binaryPath || generation !== this.generation || this.state.status === 'error') {
			return;
		}

		this.cloudflaredBinaryPath = binaryPath;
		await this.spawnTunnel(port, generation, 1);
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

		this.clearRetryTimer();

		if (this.cloudflared) {
			this.cloudflared.stop();
			this.cloudflared = null;
		}

		if (this.ngrok) {
			this.ngrok.kill();
			this.ngrok = null;
		}

		this.stopAdoptedProcess();
	}

	/**
	 * A detached cloudflared is already proxying this port. Reuse it when its pid is still that
	 * process and /quicktunnel on the recorded metrics port returns the same hostname. A mismatch
	 * or a rejected hostname retires that pid so the caller can request a new tunnel.
	 */
	private async adoptRunningTunnel(port: number, generation: number): Promise<boolean> {
		const recorded = RuntimeStateStore.read().tunnel;
		const recordedUrl = recorded?.url ?? null;
		const pid = recorded?.pid ?? null;
		const metricsPort = recorded?.metricsPort ?? null;

		if (!recordedUrl || pid == null || metricsPort == null) {
			return false;
		}

		if (!CloudflaredProcess.isRunningCommand(pid, port)) {
			return false;
		}

		this.adoptedPid = pid;
		const probe = new DetachedCloudflared(this.noopListener());
		const reported = await probe.readQuickTunnelHostname(metricsPort, config.tunnelManager.quickTunnelAdoptAttempts);

		if (generation !== this.generation) {
			return false;
		}

		if (!reported || !probe.hostnameMatches(recordedUrl, reported)) {
			if (!reported) {
				this.adoptedPid = null;
			}

			return false;
		}

		if (!TunnelHostnameScreen.isAcceptable(recordedUrl)) {
			this.onLog({
				timestamp: Date.now(),
				level: 'warn',
				message: 'Running tunnel hostname rejected by the word filter, replacing it with a new tunnel'
			});

			return false;
		}

		this.adoptedPid = null;
		const cloudflared = this.openCloudflared(port, generation, 1);
		cloudflared.attach({
			pid,
			metricsPort,
			originPort: port,
			logPath: config.paths.cloudflaredLogPath
		});
		this.cloudflared = cloudflared;
		this.retryAttempt = 0;
		this.onLog({ timestamp: Date.now(), level: 'info', message: `Tunnel URL: ${recordedUrl}` });
		this.setState({ status: 'running', url: recordedUrl, error: null });
		this.scheduleAutoStop();

		return true;
	}

	private noopListener(): DetachedCloudflaredListener {
		return {
			onLog() {},
			onUrl() {},
			onExit() {}
		};
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

	private async ensureBinary(generation: number): Promise<string | null> {
		if (fs.existsSync(bin)) {
			return bin;
		}

		const userBinPath = this.resolveUserBinaryPath();

		if (userBinPath) {
			use(userBinPath);

			return userBinPath;
		}

		this.setState({ status: 'installing', url: null, error: null });
		this.onLog({ timestamp: Date.now(), level: 'info', message: `Downloading cloudflared ${CLOUDFLARED_VERSION}...` });

		try {
			const installedPath = await CloudflaredInstaller.install(this.getCloudflaredBinPath());

			use(installedPath);
			if (generation !== this.generation) return null;
			this.onLog({
				timestamp: Date.now(),
				level: 'info',
				message: `cloudflared ${CLOUDFLARED_VERSION} installed and checksum-verified`
			});
			this.setState({ status: 'starting', url: null, error: null });

			return installedPath;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.onLog({ timestamp: Date.now(), level: 'error', message: `Failed to install cloudflared: ${message}` });
			if (generation !== this.generation) return null;
			this.setState({ status: 'error', url: null, error: `Install failed: ${message}` });

			return null;
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
	 * The quick-tunnel hostname from /quicktunnel is screened before anything is published.
	 * A rejected hostname never reaches the log or the state; its process is stopped and another
	 * tunnel is requested. A process that exits is retried with backoff, cancelled by generation.
	 */
	private async spawnTunnel(port: number, generation: number, attempt: number): Promise<void> {
		const binaryPath = this.cloudflaredBinaryPath;

		if (!binaryPath || generation !== this.generation) {
			return;
		}

		const cloudflared = this.openCloudflared(port, generation, attempt);
		this.cloudflared = cloudflared;
		this.attemptSaw429 = false;
		this.attemptLogLine = null;

		try {
			await cloudflared.start({
				binaryPath,
				origin: localApiBaseUrl(port),
				originPort: port,
				configArg: this.getCloudflaredConfigArg(),
				logPath: config.paths.cloudflaredLogPath
			});
		} catch (error) {
			if (this.cloudflared !== cloudflared) {
				cloudflared.stop();

				return;
			}

			this.cloudflared = null;
			const message = error instanceof Error ? error.message : String(error);
			this.scheduleRetry(generation, message);

			return;
		}

		if (generation !== this.generation || this.cloudflared !== cloudflared) {
			cloudflared.stop();

			if (this.cloudflared === cloudflared) {
				this.cloudflared = null;
			}

			return;
		}

		this.setState({ ...this.state });
	}

	private openCloudflared(port: number, generation: number, attempt: number): DetachedCloudflared {
		const cloudflared = new DetachedCloudflared({
			onLog: (line) => {
				this.handleCloudflaredLog(cloudflared, line);
			},
			onUrl: (url) => {
				this.handleCloudflaredUrl(cloudflared, port, generation, attempt, url);
			},
			onExit: (exit) => {
				this.handleCloudflaredExit(cloudflared, generation, exit.reason);
			}
		});

		return cloudflared;
	}

	private handleCloudflaredLog(cloudflared: DetachedCloudflared, line: string): void {
		if (this.cloudflared !== cloudflared) {
			return;
		}

		this.attemptLogLine = line;

		if (line.includes('status 429')) {
			this.attemptSaw429 = true;
		}

		this.onLog({ timestamp: Date.now(), level: 'info', message: TunnelHostnameScreen.redact(line) });
	}

	private handleCloudflaredUrl(
		cloudflared: DetachedCloudflared,
		port: number,
		generation: number,
		attempt: number,
		url: string
	): void {
		if (this.cloudflared !== cloudflared || url === QUICK_TUNNEL_API_URL) {
			return;
		}

		if (!TunnelHostnameScreen.isAcceptable(url)) {
			this.cloudflared = null;
			cloudflared.stop();
			this.rerollQuickTunnel(port, generation, attempt);

			return;
		}

		this.retryAttempt = 0;
		this.attemptSaw429 = false;
		this.attemptLogLine = null;
		this.onLog({ timestamp: Date.now(), level: 'info', message: `Tunnel URL: ${url}` });
		this.setState({ status: 'running', url, error: null });
		this.scheduleAutoStop();
	}

	private handleCloudflaredExit(cloudflared: DetachedCloudflared, generation: number, reason: string): void {
		if (this.cloudflared !== cloudflared) {
			return;
		}

		this.cloudflared = null;
		const detail = this.attemptLogLine ?? reason;
		this.onLog({
			timestamp: Date.now(),
			level: 'warn',
			message: `Tunnel exited: ${TunnelHostnameScreen.redact(detail)}`
		});

		if (this.state.status === 'stopped') {
			return;
		}

		this.scheduleRetry(generation, detail);
	}

	private scheduleRetry(generation: number, reason: string): void {
		if (generation !== this.generation) {
			return;
		}

		const port = this.quickTunnelPort;

		if (port == null) {
			return;
		}

		this.clearRetryTimer();
		this.retryAttempt += 1;
		const delay = this.retryDelay(this.retryAttempt, this.attemptSaw429);
		const shown = TunnelHostnameScreen.redact(reason);
		const error = `Attempt ${this.retryAttempt} failed: ${shown}`;
		this.onLog({
			timestamp: Date.now(),
			level: 'warn',
			message: `${error}. Retrying in ${Math.round(delay / 1000)}s.`
		});
		this.setState({ status: 'error', url: null, error });
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;

			if (generation !== this.generation) {
				return;
			}

			this.setState({ status: 'starting', url: null, error });
			void this.spawnTunnel(port, generation, 1);
		}, delay);
	}

	private retryDelay(attempt: number, rateLimited: boolean): number {
		const { startRetryDelaysMs, startRetryLongDelayMs } = config.tunnelManager;

		if (rateLimited) {
			return startRetryLongDelayMs;
		}

		const index = attempt - 1;

		if (index >= 0 && index < startRetryDelaysMs.length) {
			return startRetryDelaysMs[index];
		}

		return startRetryLongDelayMs;
	}

	private clearRetryTimer(): void {
		if (!this.retryTimer) {
			return;
		}

		clearTimeout(this.retryTimer);
		this.retryTimer = null;
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

			void this.spawnTunnel(port, generation, nextAttempt);
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
			current.tunnel.pid = this.cloudflared?.getPid() ?? null;
			current.tunnel.metricsPort = this.cloudflared?.getMetricsPort() ?? null;

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
