import { DEFAULT_AUTO_TUNNEL_ENABLED, DEFAULT_KEY_FIX_ENABLED, type RuntimeState } from '@ungate/shared/frontend';

export class RuntimeStateDefaults {
	public static create(): RuntimeState {
		const now = Date.now();

		return {
			api: {
				pid: null,
				port: null,
				status: 'stopped',
				lastSeenAt: now,
				lastError: null,
				ownerWindowId: null,
				startSuppressed: false
			},
			tunnel: {
				status: 'stopped',
				url: null,
				lastSeenAt: now,
				lastError: null,
				ownerWindowId: null,
				warning: null
			},
			keyFix: {
				enabled: DEFAULT_KEY_FIX_ENABLED
			},
			autoTunnel: {
				enabled: DEFAULT_AUTO_TUNNEL_ENABLED,
				lastAppliedUrl: null
			},
			tunnelProvider: 'quick',
			clients: {},
			commands: []
		};
	}
}
