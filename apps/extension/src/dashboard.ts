import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { LogRingBuffer, type LogEntry } from './log-ring-buffer';

import type { TunnelState } from './tunnel-manager';

const LOG_BUFFER_SIZE = 500;

export class Dashboard {
	private panel: vscode.WebviewPanel | null = null;
	private readonly apiLogBuffer = new LogRingBuffer(LOG_BUFFER_SIZE);
	private readonly tunnelLogBuffer = new LogRingBuffer(LOG_BUFFER_SIZE);
	private currentPort: number | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onMessage: (message: { type: string; url?: string }) => void
	) {}

	show(): void {
		if (this.panel) {
			this.panel.reveal();

			return;
		}

		this.panel = vscode.window.createWebviewPanel('ungate', 'Ungate', vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(this.getWebDistPath())]
		});

		this.panel.webview.onDidReceiveMessage((message: unknown) => {
			if (typeof message !== 'object' || message === null || !('type' in message)) {
				return;
			}

			this.onMessage(message as { type: string; url?: string });
		});

		this.panel.webview.html = this.buildHtml();

		this.panel.onDidChangeViewState(() => {
			if (this.panel?.visible) {
				this.sendBufferedLogs('api');
				this.sendBufferedLogs('tunnel');
			}
		});

		this.panel.onDidDispose(() => {
			this.panel = null;
		});
	}

	setPort(port: number | null): void {
		this.currentPort = port;
		this.sendPort();
		this.rebuildHtml();
	}

	pushLog(source: 'api' | 'tunnel', entry: LogEntry): void {
		const buffer = source === 'api' ? this.apiLogBuffer : this.tunnelLogBuffer;
		buffer.push(entry);

		this.panel?.webview.postMessage({ type: 'log', source, entry });
	}

	sendInitialState(tunnelState: TunnelState): void {
		this.sendPort();
		this.sendBufferedLogs('api');
		this.sendBufferedLogs('tunnel');
		this.panel?.webview.postMessage({ type: 'tunnel-status', state: tunnelState });
	}

	sendTunnelState(state: TunnelState): void {
		this.panel?.webview.postMessage({ type: 'tunnel-status', state });
	}

	isOpen(): boolean {
		return this.panel !== null;
	}

	private sendPort(): void {
		this.panel?.webview.postMessage({ type: 'port', port: this.currentPort });
	}

	private rebuildHtml(): void {
		if (!this.panel) {
			return;
		}

		this.panel.webview.html = this.buildHtml();
	}

	private sendBufferedLogs(source: 'api' | 'tunnel'): void {
		const buffer = source === 'api' ? this.apiLogBuffer : this.tunnelLogBuffer;
		const entries = buffer.getAll();

		if (entries.length > 0) {
			this.panel?.webview.postMessage({ type: 'log-bulk', source, entries });
		}
	}

	private getWebDistPath(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return path.join(this.context.extensionPath, '..', 'web', 'dist');
		}

		return path.join(this.context.extensionPath, 'bundled', 'web', 'dist');
	}

	private buildHtml(): string {
		const distPath = this.getWebDistPath();
		const assetsUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'assets')));
		const faviconUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'favicon.png')));

		let html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');

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
