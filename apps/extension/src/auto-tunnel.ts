import { DEFAULT_AUTO_TUNNEL_ENABLED, type RuntimeState } from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { RuntimeStateStore } from './runtime-state';

const config = {
	logPrefix: '[auto-tunnel]',
	openSettingsCommand: 'aiSettings.action.open',
	settingsTab: 'models',
	actions: {
		openSettings: 'Open Cursor Settings',
		copyAgain: 'Copy again'
	}
} as const;

export interface AutoTunnelDeps {
	/** Starts the tunnel without waiting; failures surface through the tunnel state. */
	startTunnel(port: number): void;
	ensureKeyEnabled(): Promise<void>;
	onStateChange(enabled: boolean): void;
	log(message: string): void;
}

export interface AutoTunnelContext {
	port: number | null;
	/** True when this window is the one that handles tunnel commands. */
	ownsTunnel: boolean;
}

/**
 * Starts the tunnel once per API process and, each time the tunnel URL changes, hands the new
 * base URL to the user. Cursor exposes no command to write the OpenAI base URL or key, so the
 * URL is copied and Cursor's model settings are one click away.
 */
export class AutoTunnel {
	private enabled = DEFAULT_AUTO_TUNNEL_ENABLED;
	private startedForApi: string | null = null;
	private announcing: string | null = null;

	constructor(private readonly deps: AutoTunnelDeps) {}

	public isEnabled(): boolean {
		return this.enabled;
	}

	public async setEnabledByUser(enabled: boolean): Promise<void> {
		await RuntimeStateStore.mutate((current) => {
			current.autoTunnel.enabled = enabled;

			if (enabled) {
				// Turning the toggle on announces the current URL even if it was announced before.
				current.autoTunnel.lastAppliedUrl = null;
			}

			return current;
		});

		if (enabled) {
			this.startedForApi = null;
		}

		this.applyEnabled(enabled);
	}

	/** Called on every runtime sync tick; never waits for the tunnel to come up. */
	public async reconcile(runtimeState: RuntimeState, context: AutoTunnelContext): Promise<void> {
		this.applyEnabled(runtimeState.autoTunnel.enabled);

		if (!this.enabled || !context.ownsTunnel) {
			return;
		}

		const { api, tunnel } = runtimeState;

		if (tunnel.status === 'running' && tunnel.url) {
			if (runtimeState.autoTunnel.lastAppliedUrl !== tunnel.url) {
				await this.onTunnelUrl(tunnel.url);
			}

			return;
		}

		const port = api.port ?? context.port;

		if (api.status !== 'running' || port == null || tunnel.status !== 'stopped') {
			return;
		}

		const apiKey = `${api.pid ?? 'unknown'}:${port}`;

		if (this.startedForApi === apiKey) {
			return;
		}

		this.startedForApi = apiKey;
		this.deps.log(`${config.logPrefix} starting tunnel on port ${port}`);

		this.deps.startTunnel(port);
	}

	public async onTunnelUrl(url: string): Promise<void> {
		if (!this.enabled || this.announcing === url) {
			return;
		}

		this.announcing = url;

		try {
			let isNew = false;
			await RuntimeStateStore.mutate((current) => {
				if (!current.autoTunnel.enabled || current.autoTunnel.lastAppliedUrl === url) {
					return current;
				}

				isNew = true;
				current.autoTunnel.lastAppliedUrl = url;

				return current;
			});

			if (!isNew) {
				return;
			}

			await this.announce(`${url}/v1`);
		} finally {
			this.announcing = null;
		}
	}

	private async announce(apiUrl: string): Promise<void> {
		this.deps.log(`${config.logPrefix} new tunnel URL ${apiUrl}`);
		await vscode.env.clipboard.writeText(apiUrl);
		await this.deps.ensureKeyEnabled();

		void vscode.window
			.showInformationMessage(
				`Ungate tunnel URL changed. ${apiUrl} is copied: paste it into Cursor Settings → Models → OpenAI Base URL (and the API key from Ungate's Server Configuration, if you set one).`,
				config.actions.openSettings,
				config.actions.copyAgain
			)
			.then(async (choice) => {
				if (choice === config.actions.openSettings) {
					await vscode.commands.executeCommand(config.openSettingsCommand, config.settingsTab);
				}

				if (choice === config.actions.copyAgain) {
					await vscode.env.clipboard.writeText(apiUrl);
				}
			});
	}

	private applyEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}

		this.enabled = enabled;
		this.deps.onStateChange(enabled);
	}
}
