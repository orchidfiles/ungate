import * as vscode from 'vscode';

import { ApiServer } from './api-server';
import { Dashboard, type Msg } from './dashboard';
import { extensionCommands } from './extension-commands';
import { ExtensionStatusBar } from './extension-status-bar';
import { OpenAiKeyFix } from './openai-key-fix';
import { TunnelManager } from './tunnel-manager';

import type { LogEntry } from './utils/log-ring-buffer';

type ApiLifecycleStatus = 'running' | 'stopped' | 'error';

export class ExtensionController {
	private outputChannel!: vscode.OutputChannel;
	private statusBar!: vscode.StatusBarItem;
	private dashboard!: Dashboard;
	private tunnelManager!: TunnelManager;
	private apiServer!: ApiServer;
	private keyFix!: OpenAiKeyFix;
	private currentPort: number | null = null;
	private lastApiStatus: ApiLifecycleStatus | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {}

	public activate(): void {
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
			}
		);

		this.tunnelManager = new TunnelManager(
			(state) => {
				this.dashboard.sendTunnelState(state);
				this.updateStatusBar();
			},
			(entry) => {
				this.log(`[tunnel] ${entry.message}`);
				this.dashboard.pushLog('tunnel', entry);
			}
		);

		this.apiServer = new ApiServer(this.context, {
			onLog: (level: LogEntry['level'], message: string) => {
				this.log(message);
				this.dashboard.pushLog('api', { timestamp: Date.now(), level, message });
			},
			onPortDetected: (port: number) => {
				this.handleApiServerPortDetected(port);
			},
			onStatusChange: (status) => {
				this.handleApiServerStatusChange(status);
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

		void this.apiServer.start().catch((err: unknown) => {
			const message = this.formatError(err);
			this.log(`[native] Failed to install native dependencies: ${message}`);
			this.dashboard.pushLog('api', { timestamp: Date.now(), level: 'error', message });
			this.applyApiServerStatus('error');
		});
		void this.keyFix.activate().catch((error: unknown) => {
			this.log(`[openai-key-fix] activation failed: ${this.formatError(error)}`);
		});

		this.context.subscriptions.push({
			dispose: () => {
				this.stopBackendServices();
			}
		});
	}

	public stopBackendServices(): void {
		this.keyFix?.stop();
		this.apiServer?.stop();
		this.tunnelManager?.stop();
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
		return this.tunnelManager.getState().url;
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
		const tunnel = this.tunnelManager.getState();
		const tunnelApiUrl = this.getTunnelApiUrl();
		let keyFixEnabled = true;

		if (this.keyFix) {
			keyFixEnabled = this.keyFix.isEnabled();
		}

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

	private async restartTunnelFromStatusBar(): Promise<void> {
		if (!this.currentPort) {
			void vscode.window.showWarningMessage('Cannot start tunnel: API is not running yet.');

			return;
		}

		const port = this.currentPort;

		this.log(`[tunnel] restart requested from status bar (port ${port})`);

		try {
			const apiUrl = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Starting tunnel…',
					cancellable: false
				},
				async () => {
					await this.tunnelManager.restart(port);
					const url = await this.waitForTunnelUrl();

					return `${url}/v1`;
				}
			);

			const action = await vscode.window.showInformationMessage('Tunnel is running.', { detail: apiUrl }, 'Copy URL');

			if (action === 'Copy URL') {
				await vscode.env.clipboard.writeText(apiUrl);
				void vscode.window.showInformationMessage('Tunnel URL copied to clipboard.');
			}
		} catch (err: unknown) {
			const message = this.formatError(err);
			this.reportTunnelError(`[tunnel] restart failed: ${message}`, `Restart failed: ${message}`);
		}
	}

	private async waitForTunnelUrl(timeoutMs = 30000): Promise<string> {
		const startedAt = Date.now();

		while (Date.now() - startedAt < timeoutMs) {
			const state = this.tunnelManager.getState();

			if (state.status === 'running' && state.url) {
				return state.url;
			}

			if (state.status === 'error') {
				throw new Error(state.error ?? 'Tunnel failed to start.');
			}

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 250);
			});
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
			this.apiServer.restart();

			return;
		}

		if (message.type === 'start-tunnel') {
			this.handleDashboardStartTunnel();

			return;
		}

		if (message.type === 'stop-tunnel') {
			this.tunnelManager.stop();

			return;
		}

		if (message.type === 'restart-tunnel') {
			this.handleDashboardRestartTunnel();

			return;
		}

		if (message.type === 'set-key-fix-enabled') {
			void this.setKeyFixByUser(message.enabled);
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
}
