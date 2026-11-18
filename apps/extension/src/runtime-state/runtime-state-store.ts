import { localApiHealthUrl } from '@ungate/shared';

import { CloudflaredProcess } from './cloudflared-process';
import { config } from './config';
import { RuntimeStateFileStore } from './file-store';
import { RuntimeStateNormalizer } from './normalizer';

import type { RuntimeCommand, RuntimeState } from '@ungate/shared/frontend';

export interface StaleApiRestartInput {
	now: number;
	pidAlive: boolean;
	portHealthy: boolean;
	startingTimeoutMs: number;
}

export class RuntimeStateStore {
	/**
	 * A saved API needs a leader start when it is `running` but its pid or IPv4 health is gone,
	 * or when it is `stopped` / `error` and the port is down. A fresh `starting` state belongs
	 * to a window that is still booting. `startSuppressed` stays down: that latch is for a
	 * spawn that cannot run, not for a missed health check.
	 */
	public static staleRunningApiNeedsRestart(api: RuntimeState['api'], input: StaleApiRestartInput): boolean {
		if (api.startSuppressed) {
			return false;
		}

		if (api.status === 'starting' && input.now - api.lastSeenAt < input.startingTimeoutMs) {
			return false;
		}

		if (api.status === 'stopped' || api.status === 'error') {
			if (api.port == null || !input.portHealthy) {
				return true;
			}

			return false;
		}

		if (api.status !== 'running' && api.status !== 'starting') {
			return false;
		}

		if (api.pid != null && !input.pidAlive) {
			return true;
		}

		if (api.port != null && !input.portHealthy) {
			return true;
		}

		if (api.status === 'running' && api.pid == null) {
			return true;
		}

		return false;
	}

	public static isProcessAlive(pid: number | null): boolean {
		if (pid == null || !Number.isInteger(pid) || pid <= 0) {
			return false;
		}

		try {
			process.kill(pid, 0);

			return true;
		} catch (error) {
			if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
				return true;
			}

			return false;
		}
	}

	public static read(): RuntimeState {
		return RuntimeStateFileStore.read();
	}

	public static write(next: RuntimeState): void {
		RuntimeStateFileStore.write(next);
	}

	public static mutate(mutator: (current: RuntimeState) => RuntimeState): Promise<RuntimeState> {
		return RuntimeStateFileStore.mutate(mutator);
	}

	public static async touchClient(windowId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			const now = Date.now();
			const clients = RuntimeStateNormalizer.filterLiveClients(current.clients, now);
			const previous = clients[windowId];

			if (!previous || now - previous.lastSeenAt >= config.runtimeState.heartbeatThrottleMs) {
				clients[windowId] = { lastSeenAt: now };
			}

			current.clients = clients;

			return current;
		});
	}

	public static async removeClient(windowId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			const clients = { ...current.clients };
			delete clients[windowId];
			current.clients = clients;

			return current;
		});
	}

	public static getLiveClientIds(state: RuntimeState, now = Date.now()): string[] {
		return Object.entries(state.clients)
			.filter(([, entry]) => now - entry.lastSeenAt <= config.runtimeState.staleClientMs)
			.map(([id]) => id);
	}

	public static hasLiveClients(state: RuntimeState, now = Date.now()): boolean {
		return this.getLiveClientIds(state, now).length > 0;
	}

	public static getLeaderWindowId(state: RuntimeState, now = Date.now()): string | null {
		const live = this.getLiveClientIds(state, now).sort();

		if (live.length === 0) {
			return null;
		}

		return live[0];
	}

	public static async reconcileOrphanedTunnel(state: RuntimeState = this.read()): Promise<RuntimeState> {
		if (!this.isOrphanedTunnel(state)) {
			return state;
		}

		// The owner window is gone, but cloudflared may still be proxying the API.
		// Dropping the URL here is what mints a new quick-tunnel name on the next start.
		if (state.tunnel.url && CloudflaredProcess.findServing(state.api.port)) {
			return state;
		}

		return await this.mutate((current) => {
			if (!this.isOrphanedTunnel(current)) {
				return current;
			}

			if (current.tunnel.url && CloudflaredProcess.findServing(current.api.port)) {
				return current;
			}

			const now = Date.now();

			current.tunnel.status = 'stopped';
			current.tunnel.url = null;
			current.tunnel.lastError = null;
			current.tunnel.ownerWindowId = null;
			current.tunnel.lastSeenAt = now;

			return current;
		});
	}

	public static getFilePath(): string {
		return RuntimeStateFileStore.getFilePath();
	}

	public static async enqueueCommand(command: RuntimeCommand): Promise<RuntimeState> {
		return await this.mutate((current) => {
			current.commands.push(command);

			return current;
		});
	}

	public static peekCommand(): RuntimeCommand | null {
		const state = this.read();

		if (state.commands.length === 0) {
			return null;
		}

		return state.commands[0];
	}

	public static async removeCommand(commandId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			current.commands = current.commands.filter((command) => command.id !== commandId);

			return current;
		});
	}

	public static isApiStartSuppressed(state: RuntimeState = this.read()): boolean {
		return state.api.startSuppressed === true;
	}

	public static async prepareApiForBootstrap(): Promise<RuntimeState> {
		const current = this.read();
		let portHealthy = false;

		if (current.api.port !== null) {
			portHealthy = await this.isApiPortHealthy(current.api.port);
		}

		if (portHealthy) {
			return await this.mutate((state) => {
				state.api.startSuppressed = false;

				return state;
			});
		}

		return await this.mutate((state) => {
			const now = Date.now();

			state.api.startSuppressed = false;
			state.api.status = 'stopped';
			state.api.ownerWindowId = null;
			state.api.pid = null;
			state.api.port = null;
			state.api.lastSeenAt = now;

			return state;
		});
	}

	public static async suppressApiAutoStart(message: string): Promise<void> {
		await this.mutate((current) => {
			const now = Date.now();

			current.api.status = 'error';
			current.api.lastError = message;
			current.api.startSuppressed = true;
			current.api.ownerWindowId = null;
			current.api.lastSeenAt = now;

			return current;
		});
	}

	public static async resetApiForRestart(): Promise<void> {
		await this.mutate((current) => {
			const now = Date.now();

			current.api.status = 'stopped';
			current.api.lastError = null;
			current.api.startSuppressed = false;
			current.api.ownerWindowId = null;
			current.api.pid = null;
			current.api.port = null;
			current.api.lastSeenAt = now;

			return current;
		});
	}

	public static async isApiPortHealthy(port: number): Promise<boolean> {
		try {
			const response = await fetch(localApiHealthUrl(port), {
				signal: AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs)
			});

			return response.ok;
		} catch {
			return false;
		}
	}

	private static isActiveTunnel(state: RuntimeState): boolean {
		const status = state.tunnel.status;

		if (status === 'running' || status === 'starting' || status === 'installing') {
			return true;
		}

		return false;
	}

	private static isOrphanedTunnel(state: RuntimeState, now = Date.now()): boolean {
		if (!this.isActiveTunnel(state)) {
			return false;
		}

		const ownerId = state.tunnel.ownerWindowId;

		if (ownerId === null) {
			return true;
		}

		if (!this.getLiveClientIds(state, now).includes(ownerId)) {
			return true;
		}

		return false;
	}
}
