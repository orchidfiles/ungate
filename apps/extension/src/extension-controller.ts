import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	cursorBridgeSocketName,
	DEFAULT_AUTO_TUNNEL_ENABLED,
	DEFAULT_KEY_FIX_ENABLED,
	type ApiStatus as ApiLifecycleStatus,
	type LogEntry,
	type RuntimeCommandAction,
	type RuntimeState,
	type TunnelState
} from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { ApiServer } from './api-server';
import { AutoTunnel } from './auto-tunnel';
import { BridgeSocket } from './cursor/bridge-socket';
import { CursorBridge } from './cursor/cursor-bridge';
import { CursorDiskSession } from './cursor/cursor-disk-session';
import { CursorSession } from './cursor/cursor-session';
import { createStateDbItemReader } from './cursor/state-db-item-reader';
import { Dashboard, type Msg } from './dashboard';
import { extensionCommands } from './extension-commands';
import { ExtensionStatusBar } from './extension-status-bar';
import { OpenAiKeyFix } from './openai-key-fix';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { TunnelManager } from './tunnel-manager';

export class ExtensionController {
	private outputChannel!: vscode.OutputChannel;
	private statusBar!: vscode.StatusBarItem;
	private dashboard!: Dashboard;
	private tunnelManager!: TunnelManager;
	private apiServer!: ApiServer;
	private keyFix!: OpenAiKeyFix;
	private autoTunnel!: AutoTunnel;
	private cursorBridge!: CursorBridge;
	/** The bridge socket of an API this window adopted; null while it serves a spawned child or nothing. */
	private adoptedBridge: { port: number; socket: BridgeSocket } | null = null;
	private adoptingBridge = false;
	private lastBridgeSocketError: string | null = null;
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

	public activate(): void {
		this.extensionHostActive = true;
		this.outputChannel = vscode.window.createOutputChannel('Ungate');
		this.context.subscriptions.push(this.outputChannel);

		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBar.command = extensionCommands.openDashboard;
		this.context.subscriptions.push(this.statusBar);

		this.dashboard = new Dashboard(this.context, (message) => {
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

		this.autoTunnel = new AutoTunnel({
			startTunnel: (port) => {
				void this.tunnelManager.start(port).catch((err: unknown) => {
					const message = this.formatError(err);
					this.reportTunnelError(`[auto-tunnel] start failed: ${message}`, `Start failed: ${message}`);
				});
			},
			ensureKeyEnabled: () => this.keyFix.ensureKeyEnabled(),
			onStateChange: (enabled) => {
				this.dashboard.sendAutoTunnelState(enabled);
				this.updateStatusBar();
			},
			log: (message) => {
				this.log(message);
			}
		});

		this.tunnelManager = new TunnelManager(
			this.windowId,
			() => this.extensionHostActive,
			(state) => {
				this.currentTunnelState = state;
				this.dashboard.sendTunnelState(state);
				this.updateStatusBar();

				if (state.status === 'running' && state.url) {
					void this.autoTunnel.onTunnelUrl(state.url).catch((error: unknown) => {
						this.log(`[auto-tunnel] announce failed: ${this.formatError(error)}`);
					});
				}
			},
			(entry) => {
				this.log(`[tunnel] ${entry.message}`);
				this.dashboard.pushLog('tunnel', entry);
			}
		);

		this.cursorBridge = new CursorBridge({
			session: new CursorSession((vscode as unknown as { cursor?: unknown }).cursor, this.createCursorDiskSession()),
			isEnabled: () => RuntimeStateStore.read().cursorProvider.enabled,
			onLog: (level, message) => {
				this.log(message);
				this.dashboard.pushLog('api', { timestamp: Date.now(), level, message });
			}
		});

		this.apiServer = new ApiServer(this.context, {
			onChildSpawned: (child) => {
				this.cursorBridge.attach(child);
			},
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
		const toggleAutoTunnel = vscode.commands.registerCommand(extensionCommands.toggleAutoTunnel, () => {
			void this.setAutoTunnelByUser(!this.autoTunnel.isEnabled());
		});

		this.context.subscriptions.push(openDashboard, copyTunnelUrl, restartTunnel, toggleKeyFix, toggleAutoTunnel);

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
			void this.apiServer.stop().catch(() => {});
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
		this.cursorBridge?.detach();
		this.adoptedBridge?.socket.close();
		this.adoptedBridge = null;
		const stateAfterStop = RuntimeStateStore.read();
		const hasLiveClients = RuntimeStateStore.hasLiveClients(stateAfterStop);

		if (!hasLiveClients) {
			this.tunnelManager?.stop();
		}
	}

	private log(msg: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
	}

	/** Fallback session source for Cursor builds that block `vscode.cursor` for extensions. */
	private createCursorDiskSession(): CursorDiskSession | null {
		const storageUri = this.context.globalStorageUri as vscode.Uri | undefined;
		if (!storageUri) return null;
		const readItem = createStateDbItemReader();
		if (!readItem) {
			this.log('[cursor] node:sqlite unavailable; Cursor session can only come from vscode.cursor');

			return null;
		}
		const globalStorageDir = path.dirname(storageUri.fsPath);

		return new CursorDiskSession({
			stateDbPath: path.join(globalStorageDir, 'state.vscdb'),
			storageJsonPath: path.join(globalStorageDir, 'storage.json'),
			cursorVersion: this.cursorVersion(),
			readItem
		});
	}

	/** Cursor's own version (product.json), which differs from the VS Code API version. */
	private cursorVersion(): string {
		try {
			const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')) as {
				version?: unknown;
			};

			return typeof product.version === 'string' ? product.version : vscode.version;
		} catch {
			return vscode.version;
		}
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
		const autoTunnelEnabled = this.autoTunnel?.isEnabled() ?? DEFAULT_AUTO_TUNNEL_ENABLED;

		this.statusBar.text = ExtensionStatusBar.barText(apiState, tunnel);
		this.statusBar.tooltip = ExtensionStatusBar.createTooltip(apiState, tunnel, tunnelApiUrl, keyFixEnabled, autoTunnelEnabled);
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

		if (status === 'running') {
			void this.reconcileAutoTunnel(RuntimeStateStore.read());
		}
	}

	private async reconcileAutoTunnel(runtimeState: RuntimeState): Promise<void> {
		try {
			await this.autoTunnel.reconcile(runtimeState, {
				port: this.currentPort,
				ownsTunnel: this.shouldHandleTunnel(runtimeState)
			});
		} catch (error: unknown) {
			this.log(`[auto-tunnel] reconcile failed: ${this.formatError(error)}`);
		}
	}

	private shouldHandleTunnel(runtimeState: RuntimeState): boolean {
		const tunnelOwner = runtimeState.tunnel.ownerWindowId;
		const ownerIsLive = tunnelOwner !== null && RuntimeStateStore.getLiveClientIds(runtimeState).includes(tunnelOwner);

		return ownerIsLive ? tunnelOwner === this.windowId : this.isLeaderWindow(runtimeState);
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
			this.dashboard.sendAutoTunnelState(this.autoTunnel.isEnabled());
			this.dashboard.sendCursorProviderState(RuntimeStateStore.read().cursorProvider.enabled);

			return;
		}

		if (message.type === 'set-cursor-provider-enabled') {
			void this.setCursorProviderByUser(message.enabled);

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

		if (message.type === 'set-auto-tunnel-enabled') {
			void this.setAutoTunnelByUser(message.enabled);

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

	private async setAutoTunnelByUser(enabled: boolean): Promise<void> {
		try {
			await this.autoTunnel.setEnabledByUser(enabled);
		} catch (error: unknown) {
			void vscode.window.showErrorMessage(`Could not change auto tunnel: ${this.formatError(error)}`);
			this.dashboard.sendAutoTunnelState(this.autoTunnel.isEnabled());

			return;
		}

		this.dashboard.sendAutoTunnelState(enabled);
		this.updateStatusBar();
		await this.reconcileAutoTunnel(RuntimeStateStore.read());
	}

	private async setCursorProviderByUser(enabled: boolean): Promise<void> {
		try {
			await RuntimeStateStore.mutate((current) => {
				current.cursorProvider = { enabled };

				return current;
			});
		} catch (error: unknown) {
			void vscode.window.showErrorMessage(`Could not change the Cursor provider: ${this.formatError(error)}`);
		}

		if (!enabled) {
			this.cursorBridge.cancelAll();
		}

		this.log(`[cursor] provider ${enabled ? 'connected' : 'disconnected'}`);
		this.dashboard.sendCursorProviderState(RuntimeStateStore.read().cursorProvider.enabled);
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
		runtimeState = await this.recoverDeadApi(runtimeState);

		await this.keyFix.applySharedState(runtimeState.keyFix.enabled);
		this.applyRuntimeState(runtimeState);
		this.apiServer.syncLeaderHealthMonitor(this.isLeaderWindow(runtimeState));
		await this.syncAdoptedBridge(runtimeState);
		this.tryHandleCommand(runtimeState);
		await this.reconcileAutoTunnel(runtimeState);
	}

	/**
	 * Serves the Cursor bridge to a running API this window did not spawn, such as the systemd
	 * service, over the socket it serves. Only the leader serves it; a window that stops leading
	 * lets go so the next leader can connect.
	 */
	private async syncAdoptedBridge(runtimeState: RuntimeState): Promise<void> {
		const port = runtimeState.api.status === 'running' ? runtimeState.api.port : null;
		const wanted = port !== null && this.isLeaderWindow(runtimeState) && !this.apiServer.spawnedApi() ? port : null;

		if (this.adoptedBridge && (this.adoptedBridge.port !== wanted || !this.adoptedBridge.socket.connected)) {
			this.adoptedBridge.socket.close();
			this.adoptedBridge = null;
		}
		if (wanted === null || this.adoptedBridge || this.adoptingBridge) return;

		const socketPath = path.join(config.baseDir, cursorBridgeSocketName(wanted));
		this.adoptingBridge = true;
		try {
			const socket = await BridgeSocket.connect(socketPath);
			this.adoptedBridge = { port: wanted, socket };
			this.cursorBridge.attach(socket);
			this.log(`[cursor] serving the bridge to the API on port ${wanted} over ${socketPath}`);
		} catch (error) {
			// An API another window spawned keeps its bridge on that window's IPC channel and has no socket.
			if (this.lastBridgeSocketError !== socketPath) {
				this.lastBridgeSocketError = socketPath;
				this.log(`[cursor] no bridge socket for the API on port ${wanted}: ${this.formatError(error)}`);
			}
		} finally {
			this.adoptingBridge = false;
		}
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
		this.dashboard.sendAutoTunnelState(runtimeState.autoTunnel.enabled);
		this.dashboard.sendCursorProviderState(runtimeState.cursorProvider.enabled);
		if (!runtimeState.cursorProvider.enabled) {
			this.cursorBridge?.cancelAll();
		}
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

		const shouldHandleTunnelCommand = this.shouldHandleTunnel(runtimeState);

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

	private async recoverDeadApi(runtimeState: RuntimeState): Promise<RuntimeState> {
		if (!this.isLeaderWindow(runtimeState)) {
			return runtimeState;
		}

		if (this.apiServer.getPort() !== null || this.apiServer.isStartupInProgress()) {
			return runtimeState;
		}

		const api = runtimeState.api;
		let portHealthy = false;

		if (api.port != null) {
			portHealthy = await RuntimeStateStore.isApiPortHealthy(api.port);
		}

		const needsRestart = RuntimeStateStore.staleRunningApiNeedsRestart(api, {
			now: Date.now(),
			pidAlive: RuntimeStateStore.isProcessAlive(api.pid),
			portHealthy,
			startingTimeoutMs: config.apiServer.startingStateTimeoutMs
		});

		if (!needsRestart) {
			return runtimeState;
		}

		await RuntimeStateStore.resetApiForRestart();
		const next = RuntimeStateStore.read();
		this.startApiAsLeaderIfNeeded(next);

		return next;
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
