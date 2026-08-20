import * as path from 'node:path';

import {
	DEFAULT_KEY_FIX_ENABLED,
	sleep,
	type ApiStatus as ApiLifecycleStatus,
	type RuntimeCommandAction,
	type RuntimeState,
	type TunnelState
} from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { ApiServer } from './api-server';
import { Dashboard, type Msg } from './dashboard';
import { extensionCommands } from './extension-commands';
import { ExtensionStatusBar } from './extension-status-bar';
import { OpenAiKeyFix } from './openai-key-fix';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { SecuritySecrets } from './security-secrets';
import { TunnelManager } from './tunnel-manager';

import type { LogEntry } from './utils/log-ring-buffer';

export class ExtensionController {
	private outputChannel!: vscode.OutputChannel;
	private statusBar!: vscode.StatusBarItem;
	private dashboard!: Dashboard;
	private tunnelManager!: TunnelManager;
	private apiServer!: ApiServer;
	private keyFix!: OpenAiKeyFix;
	private currentPort: number | null = null;
	private lastApiStatus: ApiLifecycleStatus | null = null;
	private currentTunnelState: TunnelState = { status: 'stopped', url: null, error: null };
	private readonly windowId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private syncTimer: NodeJS.Timeout | null = null;
	private runtimeStateWatcher: vscode.FileSystemWatcher | null = null;
	private runtimeStateSyncDebounce: NodeJS.Timeout | null = null;
	private lastCommandId: string | null = null;
	private extensionHostActive = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	public async activate(): Promise<void> {
		this.extensionHostActive = true;
		this.outputChannel = vscode.window.createOutputChannel('Ungate');
		this.context.subscriptions.push(this.outputChannel);

		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBar.command = extensionCommands.openDashboard;
		this.context.subscriptions.push(this.statusBar);

		// Nothing may start before the secrets are readable: the administrative API key gates the
		// dashboard and the API child, and provider credentials live in the same store.
		const secrets = await this.createSecuritySecrets();

		this.dashboard = new Dashboard(this.context, secrets.adminApiKey, (message) => {
			this.handleDashboardMessage(message);
		});
		this.keyFix = new OpenAiKeyFix(
			this.context,
			(enabled) => {
				this.dashboard.sendKeyFixState(enabled);
				this.updateStatusBar();
			},
			(message) => {
				this.log(message);
			},
			() => {
				return this.isLeaderWindow();
			}
		);

		this.tunnelManager = new TunnelManager(
			this.windowId,
			() => this.extensionHostActive,
			(state) => {
				this.currentTunnelState = state;
				this.dashboard.sendTunnelState(state);
				this.updateStatusBar();
			},
			(entry) => {
				this.log(`[tunnel] ${entry.message}`);
				this.dashboard.pushLog('tunnel', entry);
			}
		);

		this.apiServer = new ApiServer(this.context, secrets, {
			onLog: (level: LogEntry['level'], message: string) => {
				this.log(message);
				this.dashboard.pushLog('api', { timestamp: Date.now(), level, message });
			},
			onPortDetected: (port: number) => {
				this.handleApiServerPortDetected(port);
			},
			onStatusChange: (status) => {
				this.handleApiServerStatusChange(status);
			},
			isLeaderWindow: () => {
				return this.isLeaderWindow();
			},
			isExtensionHostActive: () => {
				return this.extensionHostActive;
			},
			getWindowId: () => {
				return this.windowId;
			}
		});

		const openDashboard = vscode.commands.registerCommand(extensionCommands.openDashboard, () => {
			this.dashboard.show();
		});

		const copyTunnelUrl = vscode.commands.registerCommand(extensionCommands.copyTunnelUrl, () => {
			void this.copyTunnelUrlFromCommand();
		});

		const restartTunnel = vscode.commands.registerCommand(extensionCommands.restartTunnel, () => {
			void this.restartTunnelFromStatusBar();
		});
		const toggleKeyFix = vscode.commands.registerCommand(extensionCommands.toggleKeyFix, () => {
			void this.setKeyFixByUser(!this.keyFix.isEnabled());
		});

		this.context.subscriptions.push(openDashboard, copyTunnelUrl, restartTunnel, toggleKeyFix);

		this.startHeartbeat();
		this.startRuntimeSync();
		this.startRuntimeStateWatch();
		void this.bootstrapRuntime()
			.then(() => this.keyFix.activate())
			.catch((error: unknown) => {
				this.log(`[openai-key-fix] activation failed: ${this.formatError(error)}`);
			});

		this.context.subscriptions.push({
			dispose: () => {
				this.stopBackendServices();
			}
		});
	}

	public stopBackendServices(): void {
		this.extensionHostActive = false;
		void RuntimeStateStore.removeClient(this.windowId).catch(() => {});

		const disposeState = RuntimeStateStore.read();
		if (this.isLeaderWindow(disposeState)) {
			void this.apiServer?.stop().catch(() => {});
		}

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = null;
		}

		if (this.runtimeStateSyncDebounce) {
			clearTimeout(this.runtimeStateSyncDebounce);
			this.runtimeStateSyncDebounce = null;
		}

		if (this.runtimeStateWatcher) {
			this.runtimeStateWatcher.dispose();
			this.runtimeStateWatcher = null;
		}

		this.keyFix?.stop();
		const stateAfterStop = RuntimeStateStore.read();
		const hasLiveClients = RuntimeStateStore.hasLiveClients(stateAfterStop);

		if (!hasLiveClients) {
			this.tunnelManager?.stop();
		}
	}

	/**
	 * Fails closed: when VS Code SecretStorage cannot be reached there is no administrative key
	 * and no provider credential source, so activation must not continue with an open API.
	 */
	private async createSecuritySecrets(): Promise<SecuritySecrets> {
		try {
			return await SecuritySecrets.create(this.context.secrets);
		} catch (error: unknown) {
			const message = this.formatError(error);

			this.log(`[secrets] secret storage unavailable: ${message}`);
			void vscode.window.showErrorMessage(`Ungate cannot start: secret storage is unavailable (${message}).`);

			throw error;
		}
	}

	private log(msg: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
	}

	private formatError(err: unknown): string {
		if (err instanceof Error) {
			return err.message;
		}

		return String(err);
	}

	private getTunnelBaseUrl(): string | null {
		return this.currentTunnelState.url;
	}

	private getTunnelApiUrl(): string | null {
		const baseUrl = this.getTunnelBaseUrl();

		if (!baseUrl) {
			return null;
		}

		return `${baseUrl}/v1`;
	}

	private updateStatusBar(): void {
		const apiState = this.lastApiStatus ?? 'stopped';
		const tunnel = this.currentTunnelState;
		const tunnelApiUrl = this.getTunnelApiUrl();
		const keyFixEnabled = this.keyFix?.isEnabled() ?? DEFAULT_KEY_FIX_ENABLED;

		this.statusBar.text = ExtensionStatusBar.barText(apiState, tunnel);
		this.statusBar.tooltip = ExtensionStatusBar.createTooltip(apiState, tunnel, tunnelApiUrl, keyFixEnabled);
		this.statusBar.show();
	}

	private applyApiServerStatus(state: ApiLifecycleStatus): void {
		this.lastApiStatus = state;
		this.updateStatusBar();
	}

	private reportTunnelError(logLine: string, dashboardMessage: string): void {
		this.log(logLine);
		this.dashboard.pushLog('tunnel', { timestamp: Date.now(), level: 'error', message: dashboardMessage });
	}

	private handleApiServerPortDetected(port: number): void {
		const isNew = this.currentPort !== port;
		this.currentPort = port;

		if (isNew) {
			this.log(`[port] detected: ${port}`);
			this.dashboard.setPort(port);
		}

		if (this.lastApiStatus === 'running') {
			const tunnelState = this.tunnelManager.getState();

			if (tunnelState.status === 'running') {
				void this.tunnelManager.restart(port).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] restart failed after port update: ${message}`, `Restart failed: ${message}`);
				});
			}
		}
	}

	private handleApiServerStatusChange(status: ApiLifecycleStatus): void {
		if (status === 'stopped' && this.lastApiStatus === 'running') {
			this.log(`[health] port ${this.currentPort} unreachable`);
		}

		this.applyApiServerStatus(status);
	}

	private restartTunnelFromStatusBar(): void {
		const runtimeState = RuntimeStateStore.read();
		const runtimePort = runtimeState.api.port ?? this.currentPort;

		if (!runtimePort) {
			void vscode.window.showWarningMessage('Cannot start tunnel: API is not running yet.');

			return;
		}

		const port = runtimePort;

		this.log(`[tunnel] restart requested from status bar (port ${port})`);
		this.enqueueCommand('restart-tunnel');
	}

	private async waitForTunnelUrl(timeoutMs = config.extensionController.tunnelWaitTimeoutMs): Promise<string> {
		const startedAt = Date.now();

		while (Date.now() - startedAt < timeoutMs) {
			const state = this.tunnelManager.getState();

			if (state.status === 'running' && state.url) {
				return state.url;
			}

			if (state.status === 'error') {
				throw new Error(state.error ?? 'Tunnel failed to start.');
			}

			await sleep(config.extensionController.tunnelWaitPollIntervalMs);
		}

		throw new Error('Timed out while waiting for tunnel URL.');
	}

	private async copyTunnelUrlFromCommand(): Promise<void> {
		const url = this.getTunnelApiUrl();

		if (!url) {
			void vscode.window.showWarningMessage('No tunnel URL yet. Start the tunnel from the menu or dashboard.');

			return;
		}

		await vscode.env.clipboard.writeText(url);
		void vscode.window.showInformationMessage('Tunnel URL copied to clipboard.');
	}

	private handleDashboardMessage(message: Msg): void {
		if (message.type === 'open-external-url') {
			void vscode.env.openExternal(vscode.Uri.parse(message.url));

			return;
		}

		if (message.type === 'webview-ready') {
			this.dashboard.sendInitialState(this.tunnelManager.getState());
			this.dashboard.sendKeyFixState(this.keyFix.isEnabled());

			return;
		}

		if (message.type === 'restart-server') {
			this.enqueueCommand('restart-api');

			return;
		}

		if (message.type === 'start-tunnel') {
			this.enqueueCommand('start-tunnel');

			return;
		}

		if (message.type === 'stop-tunnel') {
			this.enqueueCommand('stop-tunnel');

			return;
		}

		if (message.type === 'restart-tunnel') {
			this.enqueueCommand('restart-tunnel');

			return;
		}

		if (message.type === 'set-key-fix-enabled') {
			void this.setKeyFixByUser(message.enabled);

			return;
		}

		if (message.type === 'clear-logs') {
			this.dashboard.clearLogs(message.source);
			this.enqueueCommand('clear-logs', { logSource: message.source });
		}
	}

	private async setKeyFixByUser(enabled: boolean): Promise<void> {
		try {
			await this.keyFix.setEnabledByUser(enabled);
		} catch (error: unknown) {
			void vscode.window.showErrorMessage(`OpenAI API Key auto-fix unavailable: ${this.formatError(error)}`);
			this.dashboard.sendKeyFixState(false);
			this.updateStatusBar();

			return;
		}

		this.dashboard.sendKeyFixState(enabled);
		this.updateStatusBar();
		let message = 'OpenAI API Key auto-fix disabled.';

		if (enabled) {
			message = 'OpenAI API Key auto-fix enabled.';
		}

		void vscode.window.showInformationMessage(message);
	}

	private handleDashboardStartTunnel(): void {
		if (this.currentPort) {
			this.log(`[tunnel] start requested on port ${this.currentPort}`);
			void this.tunnelManager.start(this.currentPort).catch((err: unknown) => {
				const message = this.formatError(err);
				this.reportTunnelError(`[tunnel] start failed: ${message}`, `Start failed: ${message}`);
			});

			return;
		}

		this.log('[tunnel] start requested but no port available');
		this.dashboard.pushLog('tunnel', {
			timestamp: Date.now(),
			level: 'error',
			message: 'Cannot start tunnel: API not running'
		});
	}

	private handleDashboardRestartTunnel(): void {
		if (!this.currentPort) {
			return;
		}

		void this.tunnelManager.restart(this.currentPort).catch((err: unknown) => {
			const message = this.formatError(err);
			this.reportTunnelError(`[tunnel] restart failed: ${message}`, `Restart failed: ${message}`);
		});
	}

	private startHeartbeat(): void {
		void RuntimeStateStore.touchClient(this.windowId).catch(() => {});
		this.heartbeatTimer = setInterval(() => {
			void RuntimeStateStore.touchClient(this.windowId).catch(() => {});
		}, config.extensionController.heartbeatIntervalMs);
	}

	private startRuntimeSync(): void {
		this.syncTimer = setInterval(() => {
			void this.syncFromRuntimeState().catch(() => {});
		}, config.extensionController.runtimeSyncIntervalMs);
	}

	private startRuntimeStateWatch(): void {
		const stateFileName = path.basename(config.paths.stateFilePath);

		this.runtimeStateWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(config.baseDir), stateFileName)
		);

		const scheduleSync = (): void => {
			if (this.runtimeStateSyncDebounce) {
				clearTimeout(this.runtimeStateSyncDebounce);
			}

			this.runtimeStateSyncDebounce = setTimeout(() => {
				this.runtimeStateSyncDebounce = null;
				void this.syncFromRuntimeState().catch(() => {});
			}, 100);
		};

		this.runtimeStateWatcher.onDidChange(scheduleSync);
		this.runtimeStateWatcher.onDidCreate(scheduleSync);
	}

	private async bootstrapRuntime(): Promise<void> {
		await RuntimeStateStore.touchClient(this.windowId);
		const runtimeState = await RuntimeStateStore.prepareApiForBootstrap();
		this.startApiAsLeaderIfNeeded(runtimeState);
		await this.syncFromRuntimeState();
	}

	private async syncFromRuntimeState(): Promise<void> {
		let runtimeState = RuntimeStateStore.read();
		const liveClientIds = RuntimeStateStore.getLiveClientIds(runtimeState);

		if (!liveClientIds.includes(this.windowId)) {
			runtimeState = await RuntimeStateStore.touchClient(this.windowId);
		}

		runtimeState = await RuntimeStateStore.reconcileOrphanedTunnel(runtimeState);

		await this.keyFix.applySharedState(runtimeState.keyFix.enabled);
		this.applyRuntimeState(runtimeState);
		this.apiServer.syncLeaderHealthMonitor(this.isLeaderWindow(runtimeState));
		this.tryHandleCommand(runtimeState);
	}

	private applyRuntimeState(runtimeState: RuntimeState): void {
		const resolvedPort = runtimeState.api.port ?? this.apiServer.getPort() ?? this.currentPort;

		this.currentPort = resolvedPort;
		this.lastApiStatus = runtimeState.api.status;
		this.currentTunnelState = {
			status: runtimeState.tunnel.status,
			url: runtimeState.tunnel.url,
			error: runtimeState.tunnel.lastError
		};
		this.dashboard.setPort(this.currentPort);
		this.dashboard.sendTunnelState(this.currentTunnelState);
		this.dashboard.sendKeyFixState(this.keyFix.isEnabled());
		this.updateStatusBar();
	}

	private enqueueCommand(action: RuntimeCommandAction, payload: { port?: number; logSource?: 'api' | 'tunnel' } = {}): void {
		void RuntimeStateStore.enqueueCommand({
			id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
			action,
			createdAt: Date.now(),
			originWindowId: this.windowId,
			payload: {
				port: this.currentPort ?? undefined,
				...payload
			}
		}).catch(() => {});
	}

	private tryHandleCommand(runtimeState: RuntimeState): void {
		const command = RuntimeStateStore.peekCommand();

		if (!command) {
			return;
		}

		if (command.id === this.lastCommandId) {
			return;
		}

		if (command.originWindowId === this.windowId) {
			this.lastCommandId = command.id;
		}

		const tunnelOwner = runtimeState.tunnel.ownerWindowId;
		const ownerIsLive = tunnelOwner !== null && RuntimeStateStore.getLiveClientIds(runtimeState).includes(tunnelOwner);
		const shouldHandleTunnelCommand = ownerIsLive ? tunnelOwner === this.windowId : this.isLeaderWindow(runtimeState);

		if (command.action === 'restart-api') {
			if (!this.isLeaderWindow(runtimeState)) {
				return;
			}

			void this.apiServer.restart().catch((err: unknown) => {
				this.log(`[process] restart-api failed: ${this.formatError(err)}`);
			});
			this.ackCommand(command.id);

			return;
		}

		if (command.action === 'clear-logs') {
			const logSource = command.payload?.logSource;

			if (logSource === 'api' || logSource === 'tunnel') {
				this.dashboard.clearLogs(logSource);
			}

			this.ackCommand(command.id);

			return;
		}

		if (!shouldHandleTunnelCommand) {
			return;
		}

		if (command.action === 'start-tunnel') {
			if (this.currentPort) {
				void this.tunnelManager.start(this.currentPort).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] start failed: ${message}`, `Start failed: ${message}`);
				});
			}

			this.ackCommand(command.id);

			return;
		}

		if (command.action === 'stop-tunnel') {
			this.tunnelManager.stop();
			this.ackCommand(command.id);

			return;
		}

		if (command.action === 'restart-tunnel') {
			const commandPort = command.payload?.port ?? this.currentPort;
			if (commandPort) {
				void this.tunnelManager.restart(commandPort).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[tunnel] restart failed: ${message}`, `Restart failed: ${message}`);
				});
			}

			this.ackCommand(command.id);
		}
	}

	private ackCommand(commandId: string): void {
		this.lastCommandId = commandId;
		void RuntimeStateStore.removeCommand(commandId).catch(() => {});
	}

	private isLeaderWindow(runtimeState?: RuntimeState): boolean {
		const state = runtimeState ?? RuntimeStateStore.read();
		const leaderWindowId = RuntimeStateStore.getLeaderWindowId(state);

		return leaderWindowId === this.windowId;
	}

	private startApiAsLeaderIfNeeded(runtimeState: RuntimeState): void {
		if (!this.isLeaderWindow(runtimeState)) {
			return;
		}

		if (this.apiServer.getPort() || this.apiServer.isStartupInProgress()) {
			return;
		}

		if (RuntimeStateStore.isApiStartSuppressed(runtimeState)) {
			return;
		}

		void this.apiServer.start().catch((err: unknown) => {
			const message = this.formatError(err);
			this.log(`[process] leader start failed: ${message}`);
			this.dashboard.pushLog('api', { timestamp: Date.now(), level: 'error', message });
			this.applyApiServerStatus('error');
		});
	}
}
