import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { LogRingBuffer, type LogEntry } from './log-ring-buffer';
import { TunnelManager, type TunnelState } from './tunnel-manager';

const HEALTH_CHECK_INTERVAL_MS = 1000;
const HEALTH_CHECK_URL = (port: number) => `http://localhost:${port}/health`;
const LOG_BUFFER_SIZE = 500;

let serverProcess: cp.ChildProcess | null = null;
let healthCheckTimer: NodeJS.Timeout | null = null;
let currentPort: number | null = null;
let panel: vscode.WebviewPanel | null = null;
let statusBar: vscode.StatusBarItem;
let lastKnownStatus: 'running' | 'stopped' | 'error' | null = null;
let outputChannel: vscode.OutputChannel;
let restartRequested = false;
let tunnelManager: TunnelManager;
const apiLogBuffer = new LogRingBuffer(LOG_BUFFER_SIZE);
const tunnelLogBuffer = new LogRingBuffer(LOG_BUFFER_SIZE);

function log(msg: string) {
	outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function postLog(source: 'api' | 'tunnel', entry: LogEntry): void {
	const buffer = source === 'api' ? apiLogBuffer : tunnelLogBuffer;
	buffer.push(entry);

	panel?.webview.postMessage({ type: 'log', source, entry });
}

function postTunnelState(state: TunnelState): void {
	panel?.webview.postMessage({ type: 'tunnel-status', state });
}

function sendBufferedLogs(source: 'api' | 'tunnel'): void {
	const buffer = source === 'api' ? apiLogBuffer : tunnelLogBuffer;
	const entries = buffer.getAll();

	if (entries.length > 0) {
		panel?.webview.postMessage({ type: 'log-bulk', source, entries });
	}
}

export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Ungate');
	context.subscriptions.push(outputChannel);

	tunnelManager = new TunnelManager(
		(state) => {
			postTunnelState(state);
		},
		(entry) => {
			log(`[tunnel] ${entry.message}`);
			postLog('tunnel', entry);
		}
	);

	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = 'ungate.openDashboard';
	context.subscriptions.push(statusBar);

	const openDashboard = vscode.commands.registerCommand('ungate.openDashboard', () => {
		showDashboard(context);
	});

	context.subscriptions.push(openDashboard);

	startServer(context);

	context.subscriptions.push({
		dispose: () => {
			stopHealthCheck();
			serverProcess?.kill();
			tunnelManager.stop();
		}
	});
}

function getServerCwd(context: vscode.ExtensionContext): string {
	return path.join(context.extensionPath, '..', 'api');
}

function parsePortFromOutput(data: string): number | null {
	const match = /localhost:(\d+)/.exec(data);

	if (match) {
		return parseInt(match[1], 10);
	}

	return null;
}

function parseLogLevel(line: string): LogEntry['level'] {
	const lower = line.toLowerCase();

	if (lower.includes('error') || lower.includes('fatal')) {
		return 'error';
	}

	if (lower.includes('warn')) {
		return 'warn';
	}

	return 'info';
}

function startServer(context: vscode.ExtensionContext) {
	const cwd = getServerCwd(context);

	const isDev = context.extensionMode === vscode.ExtensionMode.Development;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(isDev && { UNGATE_DB_PATH: path.join(os.homedir(), '.ungate', 'data-dev.db') })
	};

	serverProcess = cp.spawn('node', ['-r', 'source-map-support/register', 'dist/main.js'], {
		cwd,
		env,
		stdio: 'pipe',
		detached: false
	});

	serverProcess.stdout?.on('data', (data: Buffer) => {
		const text = data.toString();
		log(`[stdout] ${text.trim()}`);

		for (const line of text.split('\n').filter((l) => l.trim())) {
			postLog('api', { timestamp: Date.now(), level: parseLogLevel(line), message: line });
		}

		const port = parsePortFromOutput(text);

		if (port) {
			log(`[port] detected: ${port}`);
			currentPort = port;
		}
	});

	serverProcess.stderr?.on('data', (data: Buffer) => {
		const text = data.toString();
		log(`[stderr] ${text.trim()}`);

		for (const line of text.split('\n').filter((l) => l.trim())) {
			postLog('api', { timestamp: Date.now(), level: 'error', message: line });
		}
	});

	serverProcess.on('exit', (code, signal) => {
		log(`[process] exit code=${code} signal=${signal}`);

		if (restartRequested || code === 0) {
			restartRequested = false;
			lastKnownStatus = 'stopped';
			setTimeout(() => startServer(context), 500);

			return;
		}

		setStatus('error');
	});

	serverProcess.on('error', (err) => {
		log(`[process] error: ${err.message}`);
		setStatus('error');
	});

	startHealthCheck(context);
}

function restartServer(context: vscode.ExtensionContext) {
	log('[command] restart requested');
	restartRequested = true;
	lastKnownStatus = 'stopped';
	setStatus('stopped');

	if (!serverProcess) {
		setTimeout(() => startServer(context), 0);

		return;
	}

	serverProcess.kill();
}

function startHealthCheck(context: vscode.ExtensionContext) {
	stopHealthCheck();
	healthCheckTimer = setInterval(() => {
		if (!currentPort) return;

		void fetch(HEALTH_CHECK_URL(currentPort), { signal: AbortSignal.timeout(2000) })
			.then((res) => {
				if (res.ok) {
					const wasDown = lastKnownStatus !== 'running';

					if (wasDown) {
						log(`[health] back up on port ${currentPort}, reloading webview`);
						setStatus('running');
						updateWebviewContent(context);

						const tunnelState = tunnelManager.getState();

						if (tunnelState.status === 'running' || tunnelState.status === 'starting') {
							void tunnelManager.restart(currentPort!);
						}
					} else {
						setStatus('running');
					}
				} else {
					setStatus('error');
				}
			})
			.catch(() => {
				if (lastKnownStatus !== 'stopped') {
					log(`[health] port ${currentPort} unreachable`);
				}
				setStatus('stopped');
			});
	}, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck() {
	if (healthCheckTimer) {
		clearInterval(healthCheckTimer);
		healthCheckTimer = null;
	}
}

function setStatus(state: 'running' | 'stopped' | 'error') {
	lastKnownStatus = state;

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

function getWebviewHtml(context: vscode.ExtensionContext): string {
	const distPath = path.join(context.extensionPath, '..', 'web', 'dist');
	const assetsUri = panel!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'assets')));
	const faviconUri = panel!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'favicon.png')));

	let html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');

	html = html.replace(/src="\/assets\//g, `src="${assetsUri.toString()}/`);
	html = html.replace(/href="\/assets\//g, `href="${assetsUri.toString()}/`);
	html = html.replace('href="/favicon.png"', `href="${faviconUri.toString()}"`);

	html = html.replace('</head>', `<script>window.__PORT__ = ${currentPort}; window.__TS__ = ${Date.now()};</script>\n\t</head>`);

	return html;
}

function updateWebviewContent(context: vscode.ExtensionContext) {
	if (!panel) {
		return;
	}

	panel.webview.html = getWebviewHtml(context);
}

function sendInitialState(): void {
	sendBufferedLogs('api');
	sendBufferedLogs('tunnel');
	postTunnelState(tunnelManager.getState());
}

function handleWebviewMessage(message: unknown, context: vscode.ExtensionContext): void {
	if (typeof message !== 'object' || message === null || !('type' in message)) {
		return;
	}

	const msg = message as { type: string };

	const handlers: Record<string, () => void> = {
		'restart-server': () => restartServer(context),
		'start-tunnel': () => {
			if (currentPort) {
				void tunnelManager.start(currentPort);
			}
		},
		'stop-tunnel': () => tunnelManager.stop(),
		'restart-tunnel': () => {
			if (currentPort) {
				void tunnelManager.restart(currentPort);
			}
		}
	};

	handlers[msg.type]?.();
}

function showDashboard(context: vscode.ExtensionContext) {
	if (panel) {
		panel.reveal();

		return;
	}

	panel = vscode.window.createWebviewPanel('ungate', 'Ungate', vscode.ViewColumn.One, {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, '..', 'web', 'dist'))]
	});

	panel.webview.onDidReceiveMessage((message: unknown) => {
		handleWebviewMessage(message, context);
	});

	panel.webview.html = getWebviewHtml(context);

	panel.onDidChangeViewState(() => {
		if (panel?.visible) {
			sendInitialState();
		}
	});

	panel.onDidDispose(() => {
		panel = null;
	});

	sendInitialState();
}

export function deactivate() {
	stopHealthCheck();
	serverProcess?.kill();
	tunnelManager.stop();
}
