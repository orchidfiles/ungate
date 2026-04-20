import * as vscode from 'vscode';

import { extensionCommands } from './extension-commands';

import type { TunnelState } from './tunnel-manager';

type ApiBarStatus = 'running' | 'stopped' | 'error';

export class ExtensionStatusBar {
	public static formatApiTip(apiState: ApiBarStatus): string {
		const statusLine: Record<ApiBarStatus, string> = {
			running: `$(check) API running`,
			stopped: `$(circle-slash) API stopped`,
			error: `$(error) API error`
		};

		return statusLine[apiState];
	}

	public static formatTunnelTip(tunnel: TunnelState, tunnelApiUrl: string | null): string {
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

	public static tunnelRestartLabel(tunnel: TunnelState): string {
		if (tunnel.status === 'stopped') {
			return 'Start tunnel';
		}

		return 'Restart tunnel';
	}

	public static createTooltip(apiState: ApiBarStatus, tunnel: TunnelState, tunnelApiUrl: string | null): vscode.MarkdownString {
		const tip = new vscode.MarkdownString('', true);
		tip.isTrusted = true;

		tip.appendMarkdown(this.formatApiTip(apiState));
		tip.appendMarkdown('\n\nTunnel URL');
		tip.appendMarkdown(this.formatTunnelTip(tunnel, tunnelApiUrl));

		tip.appendMarkdown('\n\n---\n\n');

		const restartLabel = this.tunnelRestartLabel(tunnel);
		const actions: string[] = [
			`[$(layout-panel) Open Dashboard](command:${extensionCommands.openDashboard})`,
			`[$(debug-restart) ${restartLabel}](command:${extensionCommands.restartTunnel})`
		];

		if (tunnelApiUrl) {
			actions.push(`[$(clippy) Copy URL](command:${extensionCommands.copyTunnelUrl})`);
		}

		tip.appendMarkdown(actions.join(' · '));

		return tip;
	}

	public static barText(apiState: ApiBarStatus, tunnel: TunnelState): string {
		const apiIcon: Record<ApiBarStatus, string> = {
			running: '$(check)',
			stopped: '$(circle-slash)',
			error: '$(error)'
		};

		const tunnelIcon: Record<TunnelState['status'], string> = {
			running: '$(globe)',
			starting: '$(sync~spin)',
			installing: '$(sync~spin)',
			stopped: '$(circle-slash)',
			error: '$(error)'
		};

		return `Ungate: API ${apiIcon[apiState]} | Tunnel ${tunnelIcon[tunnel.status]}`;
	}
}
