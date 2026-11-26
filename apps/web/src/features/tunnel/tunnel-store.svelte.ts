import {
	DEFAULT_AUTO_TUNNEL_ENABLED,
	DEFAULT_DASHBOARD_PLACEMENT,
	DEFAULT_KEY_FIX_ENABLED,
	type DashboardPlacement,
	type ExtensionToWebview,
	type TunnelProvider,
	type TunnelState
} from '@ungate/shared/frontend';

import { postExtensionMessage } from '$shared/vscode';

interface TunnelStore {
	readonly tunnel: TunnelState;
	readonly keyFixEnabled: boolean;
	readonly autoTunnelEnabled: boolean;
	readonly provider: TunnelProvider;
	readonly tokenSet: boolean;
	readonly dashboardPlacement: DashboardPlacement;
	startTunnel(): void;
	stopTunnel(): void;
	restartTunnel(): void;
	setKeyFixEnabled(enabled: boolean): void;
	setAutoTunnelEnabled(enabled: boolean): void;
	setProvider(provider: TunnelProvider): void;
	setNgrokAuthToken(token: string): void;
	setDashboardPlacement(placement: DashboardPlacement): void;
}

const defaultState: TunnelState = { status: 'stopped', url: null, error: null };

let tunnel = $state<TunnelState>({ ...defaultState });
let keyFixEnabled = $state(DEFAULT_KEY_FIX_ENABLED);
let autoTunnelEnabled = $state(DEFAULT_AUTO_TUNNEL_ENABLED);
let provider = $state<TunnelProvider>('quick');
let tokenSet = $state(false);
let dashboardPlacement = $state<DashboardPlacement>(DEFAULT_DASHBOARD_PLACEMENT);

function handleMessage(event: MessageEvent): void {
	const message = event.data as ExtensionToWebview;

	if (message.type === 'tunnel-status') {
		tunnel = message.state;
	}

	if (message.type === 'key-fix-state') {
		keyFixEnabled = message.enabled;
	}

	if (message.type === 'auto-tunnel-state') {
		autoTunnelEnabled = message.enabled;
	}

	if (message.type === 'tunnel-config') {
		provider = message.provider;
		tokenSet = message.tokenSet;
	}

	if (message.type === 'dashboard-placement-state') {
		dashboardPlacement = message.placement;
	}
}

window.addEventListener('message', handleMessage);

function startTunnel(): void {
	postExtensionMessage({ type: 'start-tunnel' });
}

function stopTunnel(): void {
	postExtensionMessage({ type: 'stop-tunnel' });
}

function restartTunnel(): void {
	postExtensionMessage({ type: 'restart-tunnel' });
}

function setKeyFixEnabled(enabled: boolean): void {
	postExtensionMessage({ type: 'set-key-fix-enabled', enabled });
}

function setAutoTunnelEnabled(enabled: boolean): void {
	postExtensionMessage({ type: 'set-auto-tunnel-enabled', enabled });
}

function setProvider(next: TunnelProvider): void {
	provider = next;
	postExtensionMessage({ type: 'set-tunnel-provider', provider: next });
}

function setNgrokAuthToken(token: string): void {
	postExtensionMessage({ type: 'set-ngrok-auth-token', token });
}

function setDashboardPlacement(placement: DashboardPlacement): void {
	dashboardPlacement = placement;
	postExtensionMessage({ type: 'set-dashboard-placement', placement });
}

export function getTunnelStore(): TunnelStore {
	const store: TunnelStore = {
		get tunnel() {
			return tunnel;
		},
		get keyFixEnabled() {
			return keyFixEnabled;
		},
		get autoTunnelEnabled() {
			return autoTunnelEnabled;
		},
		get provider() {
			return provider;
		},
		get tokenSet() {
			return tokenSet;
		},
		get dashboardPlacement() {
			return dashboardPlacement;
		},
		startTunnel,
		stopTunnel,
		restartTunnel,
		setKeyFixEnabled,
		setAutoTunnelEnabled,
		setProvider,
		setNgrokAuthToken,
		setDashboardPlacement
	};

	return store;
}
