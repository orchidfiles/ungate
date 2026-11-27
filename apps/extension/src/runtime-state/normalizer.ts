import {
	runtimeCommandSchema,
	runtimeStateSchema,
	type RuntimeClientEntry,
	type RuntimeCommand,
	type RuntimeState,
	NgrokDomain
} from '@ungate/shared/frontend';
import { z } from 'zod';

import { config } from './config';
import { RuntimeStateDefaults } from './default-state';

export class RuntimeStateNormalizer {
	public static normalize(raw: Partial<RuntimeState>): RuntimeState {
		const next = RuntimeStateDefaults.create();
		const now = Date.now();
		const stateSchema = runtimeStateSchema as z.ZodType<Partial<RuntimeState>>;
		const parsed = stateSchema.safeParse(raw);

		if (parsed.success && parsed.data.api) {
			next.api = {
				...next.api,
				...parsed.data.api,
				startSuppressed: parsed.data.api.startSuppressed === true
			};
		}

		if (parsed.success && parsed.data.tunnel) {
			next.tunnel = {
				...next.tunnel,
				...parsed.data.tunnel
			};
		}

		if (parsed.success && parsed.data.keyFix) {
			next.keyFix = {
				...next.keyFix,
				...parsed.data.keyFix
			};
		}

		if (parsed.success && parsed.data.autoTunnel) {
			next.autoTunnel = {
				...next.autoTunnel,
				...parsed.data.autoTunnel
			};
		}

		if (parsed.success && parsed.data.tunnelProvider) {
			next.tunnelProvider = parsed.data.tunnelProvider;
		}

		if (parsed.success) {
			next.ngrokDomain = NgrokDomain.normalize(parsed.data.ngrokDomain);
		}

		if (typeof next.api.lastSeenAt !== 'number') {
			next.api.lastSeenAt = now;
		}

		if (typeof next.tunnel.lastSeenAt !== 'number') {
			next.tunnel.lastSeenAt = now;
		}

		if (raw.clients && typeof raw.clients === 'object') {
			next.clients = this.filterLiveClients(raw.clients, now);
		}

		if (Array.isArray((raw as { commands?: unknown }).commands)) {
			const queue = (raw as { commands: unknown[] }).commands;
			next.commands = queue
				.map((entry) => this.normalizeCommand(entry))
				.filter((entry): entry is RuntimeCommand => entry !== null);
		}

		const legacyCommand = (raw as { command?: unknown }).command;

		if (next.commands.length === 0 && legacyCommand && typeof legacyCommand === 'object') {
			const legacy = this.normalizeCommand(legacyCommand);

			if (legacy) {
				next.commands = [legacy];
			}
		}

		return next;
	}

	public static filterLiveClients(clients: Record<string, RuntimeClientEntry>, now: number): Record<string, RuntimeClientEntry> {
		const next: Record<string, RuntimeClientEntry> = {};

		for (const [windowId, client] of Object.entries(clients)) {
			if (!client || typeof client.lastSeenAt !== 'number') {
				continue;
			}

			if (now - client.lastSeenAt <= config.runtimeState.staleClientMs) {
				next[windowId] = { lastSeenAt: client.lastSeenAt };
			}
		}

		return next;
	}

	private static normalizeCommand(raw: unknown): RuntimeCommand | null {
		const commandSchema = runtimeCommandSchema as z.ZodType<RuntimeCommand>;
		const parsed = commandSchema.safeParse(raw);

		if (!parsed.success) {
			return null;
		}

		return parsed.data;
	}
}
