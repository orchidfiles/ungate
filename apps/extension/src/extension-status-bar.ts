import * as vscode from 'vscode';

import { extensionCommands } from './extension-commands';

import type { ApiStatus as ApiBarStatus, TunnelState } from '@ungate/shared/frontend';

export class ExtensionStatusBar {
	public static formatApiTip(apiState: ApiBarStatus): string {
		const statusLine: Record<ApiBarStatus, string> = {
			starting: '$(sync~spin) API: starting',
			running: '$(check) API: running',
			stopped: '$(circle-slash) API: stopped',
			error: '$(error) API: error'
		};

		return statusLine[apiState];
	}

	public static formatTunnelTip(tunnel: TunnelState, tunnelApiUrl: string | null): string {
		if (tunnelApiUrl) {
			return `$(globe) Tunnel: running\n\n\`${tunnelApiUrl}\``;
		}

		if (tunnel.status === 'starting' || tunnel.status === 'installing') {
			return `$(sync~spin) Tunnel: starting (${tunnel.status}...)`;
		}

		if (tunnel.status === 'error' && tunnel.error) {
			return `$(error) Tunnel: failed (${tunnel.error})`;
		}

		return '$(circle-slash) Tunnel: not started';
	}

	public static formatKeyFixTip(keyFixEnabled: boolean): string {
		if (keyFixEnabled) {
			return '$(check) OpenAI API Key: on';
		}

		return '$(circle-slash) OpenAI API Key: off';
	}

	public static formatAutoTunnelTip(autoTunnelEnabled: boolean): string {
		if (autoTunnelEnabled) {
			return '$(check) Auto-start tunnel: on';
		}

		return '$(circle-slash) Auto-start tunnel: off';
	}

	public static tunnelRestartLabel(tunnel: TunnelState): string {
		if (tunnel.status === 'stopped') {
			return 'Start tunnel';
		}

		return 'Restart tunnel';
	}

	public static createTooltip(
		apiState: ApiBarStatus,
		tunnel: TunnelState,
		tunnelApiUrl: string | null,
		keyFixEnabled: boolean,
		autoTunnelEnabled = false
	): vscode.MarkdownString {
		const tip = new vscode.MarkdownString('', true);
		tip.isTrusted = true;

		tip.appendMarkdown(this.formatApiTip(apiState));
		tip.appendMarkdown('\n\n');
		tip.appendMarkdown(this.formatKeyFixTip(keyFixEnabled));
		tip.appendMarkdown('\n\n');
		tip.appendMarkdown(this.formatAutoTunnelTip(autoTunnelEnabled));
		tip.appendMarkdown('\n\n');
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

		let keyFixLabel = 'Turn on key auto-fix';

		if (keyFixEnabled) {
			keyFixLabel = 'Turn off key auto-fix';
		}

		actions.push(`[$(settings-gear) ${keyFixLabel}](command:${extensionCommands.toggleKeyFix})`);

		const autoTunnelLabel = autoTunnelEnabled ? 'Turn off auto-start tunnel' : 'Turn on auto-start tunnel';
		actions.push(`[$(rocket) ${autoTunnelLabel}](command:${extensionCommands.toggleAutoTunnel})`);

		tip.appendMarkdown(actions.join(' · '));

		return tip;
	}

	public static barText(apiState: ApiBarStatus, tunnel: TunnelState): string {
		const apiIcon: Record<ApiBarStatus, string> = {
			starting: '$(sync~spin)',
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
