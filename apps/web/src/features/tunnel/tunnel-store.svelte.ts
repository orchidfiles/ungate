import {
	DEFAULT_AUTO_TUNNEL_ENABLED,
	DEFAULT_KEY_FIX_ENABLED,
	type ExtensionToWebview,
	type TunnelState
} from '@ungate/shared/frontend';

import { postExtensionMessage } from '$shared/vscode';

interface TunnelStore {
	readonly tunnel: TunnelState;
	readonly keyFixEnabled: boolean;
	readonly autoTunnelEnabled: boolean;
	startTunnel(): void;
	stopTunnel(): void;
	restartTunnel(): void;
	setKeyFixEnabled(enabled: boolean): void;
	setAutoTunnelEnabled(enabled: boolean): void;
}

const defaultState: TunnelState = { status: 'stopped', url: null, error: null };

let tunnel = $state<TunnelState>({ ...defaultState });
let keyFixEnabled = $state(DEFAULT_KEY_FIX_ENABLED);
let autoTunnelEnabled = $state(DEFAULT_AUTO_TUNNEL_ENABLED);

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
		startTunnel,
		stopTunnel,
		restartTunnel,
		setKeyFixEnabled,
		setAutoTunnelEnabled
	};

	return store;
}
