import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { SharedLogStore } from './runtime-state/shared-log-store';
import { LogRingBuffer } from './utils/log-ring-buffer';

import type { LogEntry, TunnelState, WebviewToExtension } from '@ungate/shared/frontend';

const LOG_BUFFER_SIZE = 500;
const LOG_POLL_INTERVAL_MS = 500;

const MSGS_SIMPLE = ['webview-ready', 'restart-server', 'start-tunnel', 'stop-tunnel', 'restart-tunnel'] as const;

export type Msg =
	| { type: 'open-external-url'; url: string }
	| { type: 'set-key-fix-enabled'; enabled: boolean }
	| { type: 'set-auto-tunnel-enabled'; enabled: boolean }
	| { type: 'clear-logs'; source: 'api' | 'tunnel' }
	| Extract<WebviewToExtension, { type: (typeof MSGS_SIMPLE)[number] }>;

const DASHBOARD_VIEW_ID = 'ungate.dashboard';

export class Dashboard implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | null = null;
	private readonly apiLogBuffer = new LogRingBuffer(LOG_BUFFER_SIZE);
	private readonly tunnelLogBuffer = new LogRingBuffer(LOG_BUFFER_SIZE);
	private currentPort: number | null = null;
	private apiLogFileOffset = 0;
	private tunnelLogFileOffset = 0;
	private logPollTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onMessage: (message: Msg) => void
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.stopLogPoll();
		this.view = webviewView;
		webviewView.webview.options = this.getWebviewOptions();

		webviewView.webview.onDidReceiveMessage((message: unknown) => {
			const parsed = Dashboard.parseIncomingMessage(message);

			if (!parsed) {
				return;
			}

			this.onMessage(parsed);
		});

		webviewView.webview.html = this.buildHtml();

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.sendBufferedLogs('api');
				this.sendBufferedLogs('tunnel');
			}
		});

		webviewView.onDidDispose(() => {
			this.stopLogPoll();
			this.view = null;
		});

		this.startLogPoll();
	}

	show(): void {
		// The agent layout hides the editor while chat is maximized, so an editor tab never appears.
		// Focusing the panel view opens the panel even when that editor area is hidden.
		void vscode.commands.executeCommand(`${DASHBOARD_VIEW_ID}.focus`);
	}

	setPort(port: number | null): void {
		if (this.currentPort === port) {
			return;
		}

		this.currentPort = port;

		if (this.view) {
			this.view.webview.options = this.getWebviewOptions();
		}

		this.sendPort();
		this.rebuildHtml();
	}

	pushLog(source: 'api' | 'tunnel', entry: LogEntry): void {
		const buffer = source === 'api' ? this.apiLogBuffer : this.tunnelLogBuffer;
		buffer.push(entry);
		SharedLogStore.append(source, entry);

		this.view?.webview.postMessage({ type: 'log', source, entry });
	}

	clearLogs(source: 'api' | 'tunnel'): void {
		const buffer = source === 'api' ? this.apiLogBuffer : this.tunnelLogBuffer;
		buffer.clear();
		SharedLogStore.clear(source);
		this.syncLogFileOffsets();
		this.view?.webview.postMessage({ type: 'logs-cleared', source });
	}

	sendInitialState(tunnelState: TunnelState): void {
		this.sendPort();
		this.sendBufferedLogs('api');
		this.sendBufferedLogs('tunnel');
		this.view?.webview.postMessage({ type: 'tunnel-status', state: tunnelState });
	}

	sendKeyFixState(enabled: boolean): void {
		this.view?.webview.postMessage({ type: 'key-fix-state', enabled });
	}

	sendAutoTunnelState(enabled: boolean): void {
		this.view?.webview.postMessage({ type: 'auto-tunnel-state', enabled });
	}

	sendTunnelState(state: TunnelState): void {
		this.view?.webview.postMessage({ type: 'tunnel-status', state });
	}

	isOpen(): boolean {
		return this.view !== null;
	}

	private static parseIncomingMessage(raw: unknown): Msg | null {
		if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
			return null;
		}

		const record = raw as Record<string, unknown>;
		const type = record.type;

		if (typeof type !== 'string') {
			return null;
		}

		if (type === 'open-external-url') {
			const url = record.url;

			if (typeof url !== 'string') {
				return null;
			}

			return { type: 'open-external-url', url };
		}

		if (type === 'set-key-fix-enabled' || type === 'set-auto-tunnel-enabled') {
			const enabled = record.enabled;

			if (typeof enabled !== 'boolean') {
				return null;
			}

			return { type, enabled };
		}

		if (type === 'clear-logs') {
			const source = record.source;

			if (source !== 'api' && source !== 'tunnel') {
				return null;
			}

			return { type: 'clear-logs', source };
		}

		for (const allowed of MSGS_SIMPLE) {
			if (allowed === type) {
				return { type: allowed };
			}
		}

		return null;
	}

	private getWebviewOptions(): vscode.WebviewOptions {
		// The webview runs on the user's machine, but the API listens wherever the extension host runs.
		// Under Remote SSH, WSL or Dev Containers those are different machines, and the editor only forwards
		// localhost ports listed in portMapping. In a local window the mapping changes nothing.
		const portMapping = this.currentPort ? [{ webviewPort: this.currentPort, extensionHostPort: this.currentPort }] : [];

		return {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(this.getWebDistPath())],
			portMapping
		};
	}

	private getWebDistPath(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return path.join(this.context.extensionPath, '..', 'web', 'dist');
		}

		return path.join(this.context.extensionPath, 'bundled', 'web', 'dist');
	}

	private sendPort(): void {
		this.view?.webview.postMessage({ type: 'port', port: this.currentPort });
	}

	private rebuildHtml(): void {
		if (!this.view) {
			return;
		}

		this.view.webview.html = this.buildHtml();
	}

	private sendBufferedLogs(source: 'api' | 'tunnel'): void {
		const entries = SharedLogStore.readAll(source);

		if (entries.length > 0) {
			this.view?.webview.postMessage({ type: 'log-bulk', source, entries });
		}

		this.syncLogFileOffsets();
	}

	private startLogPoll(): void {
		this.stopLogPoll();
		this.logPollTimer = setInterval(() => {
			this.pollSharedLogs('api');
			this.pollSharedLogs('tunnel');
		}, LOG_POLL_INTERVAL_MS);
	}

	private stopLogPoll(): void {
		if (this.logPollTimer) {
			clearInterval(this.logPollTimer);
			this.logPollTimer = null;
		}
	}

	private pollSharedLogs(source: 'api' | 'tunnel'): void {
		const offset = source === 'api' ? this.apiLogFileOffset : this.tunnelLogFileOffset;
		const { entries, nextOffset } = SharedLogStore.readSince(source, offset);

		if (source === 'api') {
			this.apiLogFileOffset = nextOffset;
		} else {
			this.tunnelLogFileOffset = nextOffset;
		}

		for (const entry of entries) {
			this.view?.webview.postMessage({ type: 'log', source, entry });
		}
	}

	private syncLogFileOffsets(): void {
		const fileSize = SharedLogStore.getFileSize();

		this.apiLogFileOffset = fileSize;
		this.tunnelLogFileOffset = fileSize;
	}

	private buildHtml(): string {
		const distPath = this.getWebDistPath();
		const assetsUri = this.view!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'assets')));
		const faviconUri = this.view!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'favicon.png')));

		let html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');

		html = html.replace(/\s+crossorigin(?:="[^"]*")?/g, '');
		html = html.replace(/src="\/assets\//g, `src="${assetsUri.toString()}/`);
		html = html.replace(/href="\/assets\//g, `href="${assetsUri.toString()}/`);
		html = html.replace('href="/favicon.png"', `href="${faviconUri.toString()}"`);
		html = html.replace(
			'</head>',
			`<script>window.__PORT__ = ${this.currentPort}; window.__TS__ = ${Date.now()};</script>\n\t</head>`
		);

		return html;
	}
}
