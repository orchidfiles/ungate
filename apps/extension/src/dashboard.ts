import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { SharedLogStore } from './runtime-state/shared-log-store';
import { LogRingBuffer } from './utils/log-ring-buffer';

import type { DashboardPlacement, LogEntry, TunnelState, WebviewToExtension } from '@ungate/shared/frontend';

const LOG_BUFFER_SIZE = 500;
const LOG_POLL_INTERVAL_MS = 500;

const MSGS_SIMPLE = ['webview-ready', 'restart-server', 'start-tunnel', 'stop-tunnel', 'restart-tunnel'] as const;

export type Msg =
	| { type: 'open-external-url'; url: string }
	| { type: 'set-key-fix-enabled'; enabled: boolean }
	| { type: 'set-auto-tunnel-enabled'; enabled: boolean }
	| { type: 'set-tunnel-provider'; provider: 'quick' | 'ngrok' }
	| { type: 'set-ngrok-auth-token'; token: string }
	| { type: 'set-dashboard-placement'; placement: DashboardPlacement }
	| { type: 'set-ngrok-domain'; domain: string | null }
	| { type: 'set-cursor-provider-enabled'; enabled: boolean }
	| { type: 'clear-logs'; source: 'api' | 'tunnel' }
	| Extract<WebviewToExtension, { type: (typeof MSGS_SIMPLE)[number] }>;

const DASHBOARD_VIEW_ID = 'ungate.dashboard';
const DASHBOARD_PLACEMENT_STATE_KEY = 'dashboardPlacement';
const LEGACY_DASHBOARD_PLACEMENT_SECTION = 'ungate';
const LEGACY_DASHBOARD_PLACEMENT_SETTING = 'dashboardPlacement';

export class Dashboard implements vscode.WebviewViewProvider {
	private panel: vscode.WebviewPanel | null = null;
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
		this.view = webviewView;
		webviewView.webview.options = this.getWebviewOptions();
		this.bindWebview(webviewView.webview);
		webviewView.webview.html = this.buildHtml(webviewView.webview);

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.sendBufferedLogs('api');
				this.sendBufferedLogs('tunnel');
			}
		});

		webviewView.onDidDispose(() => {
			this.view = null;
			this.maybeStopLogPoll();
		});

		this.ensureLogPoll();
	}

	show(): void {
		if (this.getPlacement() === 'panel') {
			// The agent layout hides the editor while chat is maximized, so an editor tab never appears.
			// Focusing the panel view opens the panel even when that editor area is hidden.
			void vscode.commands.executeCommand(`${DASHBOARD_VIEW_ID}.focus`);

			return;
		}

		this.showEditorTab();
	}

	getPlacement(): DashboardPlacement {
		const stored = this.context.globalState.get<string>(DASHBOARD_PLACEMENT_STATE_KEY);

		if (stored === 'panel' || stored === 'editor') {
			return stored;
		}

		const legacy = vscode.workspace
			.getConfiguration(LEGACY_DASHBOARD_PLACEMENT_SECTION)
			.get<string>(LEGACY_DASHBOARD_PLACEMENT_SETTING);

		if (legacy === 'panel') {
			return 'panel';
		}

		return 'editor';
	}

	async setPlacement(placement: DashboardPlacement): Promise<void> {
		await this.context.globalState.update(DASHBOARD_PLACEMENT_STATE_KEY, placement);
		await vscode.workspace
			.getConfiguration(LEGACY_DASHBOARD_PLACEMENT_SECTION)
			.update(LEGACY_DASHBOARD_PLACEMENT_SETTING, undefined, vscode.ConfigurationTarget.Global);
		this.sendPlacementState(placement);
	}

	setPort(port: number | null): void {
		if (this.currentPort === port) {
			return;
		}

		this.currentPort = port;
		const options = this.getWebviewOptions();

		if (this.panel) {
			this.panel.webview.options = options;
		}

		if (this.view) {
			this.view.webview.options = options;
		}

		this.sendPort();
		this.rebuildHtml();
	}

	pushLog(source: 'api' | 'tunnel', entry: LogEntry): void {
		const buffer = source === 'api' ? this.apiLogBuffer : this.tunnelLogBuffer;
		buffer.push(entry);
		SharedLogStore.append(source, entry);

		this.postToWebviews({ type: 'log', source, entry });
	}

	clearLogs(source: 'api' | 'tunnel'): void {
		const buffer = source === 'api' ? this.apiLogBuffer : this.tunnelLogBuffer;
		buffer.clear();
		SharedLogStore.clear(source);
		this.syncLogFileOffsets();
		this.postToWebviews({ type: 'logs-cleared', source });
	}

	sendInitialState(tunnelState: TunnelState): void {
		this.sendPort();
		this.sendBufferedLogs('api');
		this.sendBufferedLogs('tunnel');
		this.postToWebviews({ type: 'tunnel-status', state: tunnelState });
	}

	sendKeyFixState(enabled: boolean): void {
		this.postToWebviews({ type: 'key-fix-state', enabled });
	}

	sendAutoTunnelState(enabled: boolean): void {
		this.postToWebviews({ type: 'auto-tunnel-state', enabled });
	}

	sendPlacementState(placement: DashboardPlacement = this.getPlacement()): void {
		this.postToWebviews({ type: 'dashboard-placement-state', placement });
	}

	sendCursorProviderState(enabled: boolean): void {
		this.postToWebviews({ type: 'cursor-provider-state', enabled });
	}

	sendTunnelState(state: TunnelState): void {
		this.postToWebviews({ type: 'tunnel-status', state });
	}

	sendTunnelConfig(provider: 'quick' | 'ngrok', tokenSet: boolean, domain: string | null): void {
		this.postToWebviews({ type: 'tunnel-config', provider, tokenSet, domain });
	}

	isOpen(): boolean {
		return this.panel !== null || this.view !== null;
	}

	private showEditorTab(): void {
		if (this.panel) {
			this.panel.reveal();

			return;
		}

		this.panel = vscode.window.createWebviewPanel('ungate', 'Ungate', vscode.ViewColumn.One, this.getWebviewOptions());
		this.panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'icon.png'));
		this.bindWebview(this.panel.webview);
		this.panel.webview.html = this.buildHtml(this.panel.webview);

		this.panel.onDidChangeViewState(() => {
			if (this.panel?.visible) {
				this.sendBufferedLogs('api');
				this.sendBufferedLogs('tunnel');
			}
		});

		this.panel.onDidDispose(() => {
			this.panel = null;
			this.maybeStopLogPoll();
		});

		this.ensureLogPoll();
	}

	private bindWebview(webview: vscode.Webview): void {
		webview.onDidReceiveMessage((message: unknown) => {
			const parsed = Dashboard.parseIncomingMessage(message);

			if (!parsed) {
				return;
			}

			this.onMessage(parsed);
		});
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

		if (type === 'set-key-fix-enabled' || type === 'set-auto-tunnel-enabled' || type === 'set-cursor-provider-enabled') {
			const enabled = record.enabled;

			if (typeof enabled !== 'boolean') {
				return null;
			}

			return { type, enabled };
		}

		if (type === 'set-tunnel-provider') {
			const provider = record.provider;

			if (provider !== 'quick' && provider !== 'ngrok') {
				return null;
			}

			return { type: 'set-tunnel-provider', provider };
		}

		if (type === 'set-ngrok-auth-token') {
			const token = record.token;

			if (typeof token !== 'string' || token.trim().length === 0) {
				return null;
			}

			return { type: 'set-ngrok-auth-token', token: token.trim() };
		}

		if (type === 'set-dashboard-placement') {
			const placement = record.placement;

			if (placement !== 'editor' && placement !== 'panel') {
				return null;
			}

			return { type: 'set-dashboard-placement', placement };
		}

		if (type === 'set-ngrok-domain') {
			const domain = record.domain;

			if (domain === null || (typeof domain === 'string' && domain.trim().length === 0)) {
				return { type: 'set-ngrok-domain', domain: null };
			}

			if (typeof domain !== 'string' || domain.length > 512) {
				return null;
			}

			return { type: 'set-ngrok-domain', domain };
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

	private postToWebviews(message: unknown): void {
		void this.panel?.webview.postMessage(message);
		void this.view?.webview.postMessage(message);
	}

	private sendPort(): void {
		this.postToWebviews({ type: 'port', port: this.currentPort });
	}

	private rebuildHtml(): void {
		if (this.panel) {
			this.panel.webview.html = this.buildHtml(this.panel.webview);
		}

		if (this.view) {
			this.view.webview.html = this.buildHtml(this.view.webview);
		}
	}

	private sendBufferedLogs(source: 'api' | 'tunnel'): void {
		const entries = SharedLogStore.readAll(source);

		if (entries.length > 0) {
			this.postToWebviews({ type: 'log-bulk', source, entries });
		}

		this.syncLogFileOffsets();
	}

	private ensureLogPoll(): void {
		if (this.logPollTimer) {
			return;
		}

		this.logPollTimer = setInterval(() => {
			this.pollSharedLogs('api');
			this.pollSharedLogs('tunnel');
		}, LOG_POLL_INTERVAL_MS);
	}

	private maybeStopLogPoll(): void {
		if (this.panel || this.view) {
			return;
		}

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
			this.postToWebviews({ type: 'log', source, entry });
		}
	}

	private syncLogFileOffsets(): void {
		const fileSize = SharedLogStore.getFileSize();

		this.apiLogFileOffset = fileSize;
		this.tunnelLogFileOffset = fileSize;
	}

	private buildHtml(webview: vscode.Webview): string {
		const distPath = this.getWebDistPath();
		const assetsUri = webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'assets')));
		const faviconUri = webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'favicon.png')));

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
