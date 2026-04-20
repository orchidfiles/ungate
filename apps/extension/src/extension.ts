import * as vscode from 'vscode';

import { ApiServer } from './api-server';
import { Dashboard } from './dashboard';
import { TunnelManager } from './tunnel-manager';

import type { LogEntry } from './log-ring-buffer';

let apiServer: ApiServer;
let dashboard: Dashboard;
let tunnelManager: TunnelManager;
let statusBar: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let currentPort: number | null = null;
let lastStatus: 'running' | 'stopped' | 'error' | null = null;

function log(msg: string): void {
	outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function getTunnelBaseUrl(): string | null {
	return tunnelManager.getState().url;
}

function getTunnelApiUrl(): string | null {
	const baseUrl = getTunnelBaseUrl();

	if (!baseUrl) {
		return null;
	}

	return `${baseUrl}/v1`;
}

function formatApiStatusLine(): string {
	const apiState = lastStatus ?? 'stopped';
	const statusLine: Record<typeof apiState, string> = {
		running: `$(check) API running`,
		stopped: `$(circle-slash) API stopped`,
		error: `$(error) API error`
	};

	return statusLine[apiState];
}

function formatTunnelUrlMarkdown(): string {
	const tunnel = tunnelManager.getState();
	const tunnelApiUrl = getTunnelApiUrl();

	if (tunnelApiUrl) {
		return `\n\n$(globe) \`${tunnelApiUrl}\``;
	}

	if (tunnel.status === 'starting' || tunnel.status === 'installing') {
		return `\n\n$(sync~spin) tunnel is starting (${tunnel.status}…)`;
	}

	if (tunnel.status === 'error' && tunnel.error) {
		return `\n\n$(error) tunnel failed to start (${tunnel.error})`;
	}

	return '\n\n_tunnel is not started yet_';
}

function formatRestartLabel(): string {
	const tunnel = tunnelManager.getState();

	return tunnel.status === 'stopped' ? 'Start tunnel' : 'Restart tunnel';
}

function buildStatusBarTooltip(): vscode.MarkdownString {
	const tip = new vscode.MarkdownString('', true);
	tip.isTrusted = true;

	tip.appendMarkdown(formatApiStatusLine());
	tip.appendMarkdown('\n\nTunnel URL');
	tip.appendMarkdown(formatTunnelUrlMarkdown());

	tip.appendMarkdown('\n\n---\n\n');

	const restartLabel = formatRestartLabel();
	const actions = [
		`[$(layout-panel) Open Dashboard](command:ungate.openDashboard)`,
		`[$(debug-restart) ${restartLabel}](command:ungate.restartTunnel)`
	];

	if (getTunnelApiUrl()) {
		actions.push(`[$(clippy) Copy URL](command:ungate.copyTunnelUrl)`);
	}

	tip.appendMarkdown(actions.join(' · '));

	return tip;
}

function updateStatusBar(): void {
	const apiState = lastStatus ?? 'stopped';
	const tunnel = tunnelManager.getState();

	const apiIcon: Record<typeof apiState, string> = {
		running: '$(check)',
		stopped: '$(circle-slash)',
		error: '$(error)'
	};

	const tunnelIcon: Record<typeof tunnel.status, string> = {
		running: '$(globe)',
		starting: '$(sync~spin)',
		installing: '$(sync~spin)',
		stopped: '$(circle-slash)',
		error: '$(error)'
	};

	statusBar.text = `Ungate: API ${apiIcon[apiState]} | Tunnel ${tunnelIcon[tunnel.status]}`;
	statusBar.tooltip = buildStatusBarTooltip();
	statusBar.show();
}

function setStatus(state: 'running' | 'stopped' | 'error'): void {
	lastStatus = state;
	updateStatusBar();
}

async function runTunnelRestartOrWarn(): Promise<void> {
	if (!currentPort) {
		void vscode.window.showWarningMessage('Cannot start tunnel: API is not running yet.');

		return;
	}

	const port = currentPort;

	log(`[tunnel] restart requested from status bar (port ${port})`);

	try {
		const apiUrl = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Starting tunnel…',
				cancellable: false
			},
			async () => {
				await tunnelManager.restart(port);
				const url = await waitForTunnelUrl();

				return `${url}/v1`;
			}
		);

		const action = await vscode.window.showInformationMessage('Tunnel is running.', { detail: apiUrl }, 'Copy URL');

		if (action === 'Copy URL') {
			await vscode.env.clipboard.writeText(apiUrl);
			void vscode.window.showInformationMessage('Tunnel URL copied to clipboard.');
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		log(`[tunnel] restart failed: ${message}`);
		dashboard.pushLog('tunnel', { timestamp: Date.now(), level: 'error', message: `Restart failed: ${message}` });
	}
}

async function waitForTunnelUrl(timeoutMs = 30000): Promise<string> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const state = tunnelManager.getState();

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

async function copyTunnelUrlCommand(): Promise<void> {
	const url = getTunnelApiUrl();

	if (!url) {
		void vscode.window.showWarningMessage('No tunnel URL yet. Start the tunnel from the menu or dashboard.');

		return;
	}

	await vscode.env.clipboard.writeText(url);
	void vscode.window.showInformationMessage('Tunnel URL copied to clipboard.');
}

function handleWebviewMessage(message: { type: string; url?: string }): void {
	if (message.type === 'open-external-url' && message.url) {
		void vscode.env.openExternal(vscode.Uri.parse(message.url));

		return;
	}

	const handlers: Record<string, () => void> = {
		'webview-ready': () => dashboard.sendInitialState(tunnelManager.getState()),
		'restart-server': () => apiServer.restart(),
		'start-tunnel': () => {
			if (currentPort) {
				log(`[tunnel] start requested on port ${currentPort}`);
				void tunnelManager.start(currentPort).catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					log(`[tunnel] start failed: ${message}`);
					dashboard.pushLog('tunnel', { timestamp: Date.now(), level: 'error', message: `Start failed: ${message}` });
				});
			} else {
				log('[tunnel] start requested but no port available');
				dashboard.pushLog('tunnel', {
					timestamp: Date.now(),
					level: 'error',
					message: 'Cannot start tunnel: API not running'
				});
			}
		},
		'stop-tunnel': () => tunnelManager.stop(),
		'restart-tunnel': () => {
			if (currentPort) {
				void tunnelManager.restart(currentPort).catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					log(`[tunnel] restart failed: ${message}`);
					dashboard.pushLog('tunnel', { timestamp: Date.now(), level: 'error', message: `Restart failed: ${message}` });
				});
			}
		}
	};

	handlers[message.type]?.();
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Ungate');
	context.subscriptions.push(outputChannel);

	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'ungate.openDashboard';
	context.subscriptions.push(statusBar);

	dashboard = new Dashboard(context, handleWebviewMessage);

	tunnelManager = new TunnelManager(
		(state) => {
			dashboard.sendTunnelState(state);
			updateStatusBar();
		},
		(entry) => {
			log(`[tunnel] ${entry.message}`);
			dashboard.pushLog('tunnel', entry);
		}
	);

	apiServer = new ApiServer(context, {
		onLog(level: LogEntry['level'], message: string) {
			log(message);
			dashboard.pushLog('api', { timestamp: Date.now(), level, message });
		},
		onPortDetected(port: number) {
			const isNew = currentPort !== port;
			currentPort = port;

			if (isNew) {
				log(`[port] detected: ${port}`);
				dashboard.setPort(port);
			}

			if (lastStatus === 'running') {
				const tunnelState = tunnelManager.getState();

				if (tunnelState.status === 'running') {
					void tunnelManager.restart(port);
				}
			}
		},
		onStatusChange(status) {
			if (status === 'stopped' && lastStatus === 'running') {
				log(`[health] port ${currentPort} unreachable`);
			}

			setStatus(status);
		}
	});

	const openDashboard = vscode.commands.registerCommand('ungate.openDashboard', () => {
		dashboard.show();
	});

	const copyTunnelUrl = vscode.commands.registerCommand('ungate.copyTunnelUrl', () => void copyTunnelUrlCommand());
	const restartTunnel = vscode.commands.registerCommand('ungate.restartTunnel', () => void runTunnelRestartOrWarn());

	context.subscriptions.push(openDashboard, copyTunnelUrl, restartTunnel);

	void apiServer.start().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		log(`[native] Failed to install native dependencies: ${message}`);
		dashboard.pushLog('api', { timestamp: Date.now(), level: 'error', message });
		setStatus('error');
	});

	context.subscriptions.push({
		dispose: () => {
			apiServer.stop();
			tunnelManager.stop();
		}
	});
}

export function deactivate(): void {
	apiServer?.stop();
	tunnelManager?.stop();
}
