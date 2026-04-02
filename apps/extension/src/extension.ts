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

function setStatus(state: 'running' | 'stopped' | 'error'): void {
	lastStatus = state;

	const labels: Record<typeof state, { text: string; tooltip: string }> = {
		running: {
			text: `$(check) Ungate :${currentPort ?? '?'}`,
			tooltip: `Ungate proxy running on port ${currentPort ?? 'unknown'}`
		},
		stopped: {
			text: `$(circle-slash) Ungate`,
			tooltip: 'Ungate proxy stopped'
		},
		error: {
			text: `$(error) Ungate`,
			tooltip: 'Ungate proxy error'
		}
	};

	const label = labels[state];
	statusBar.text = label.text;
	statusBar.tooltip = label.tooltip;
	statusBar.show();
}

function handleWebviewMessage(type: string): void {
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

	handlers[type]?.();
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Ungate');
	context.subscriptions.push(outputChannel);

	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'ungate.openDashboard';
	context.subscriptions.push(statusBar);

	dashboard = new Dashboard(context, handleWebviewMessage);

	tunnelManager = new TunnelManager(
		(state) => dashboard.sendTunnelState(state),
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

	context.subscriptions.push(openDashboard);

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
