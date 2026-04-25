import { postExtensionMessage } from '$shared/vscode';

import type { TunnelState, ExtensionToWebview } from '@ungate/shared/frontend';

interface TunnelStore {
	readonly tunnel: TunnelState;
	readonly keyFixEnabled: boolean;
	startTunnel(): void;
	stopTunnel(): void;
	restartTunnel(): void;
	setKeyFixEnabled(enabled: boolean): void;
}

const defaultState: TunnelState = { status: 'stopped', url: null, error: null };

let tunnel = $state<TunnelState>({ ...defaultState });
let keyFixEnabled = $state(true);

function handleMessage(event: MessageEvent): void {
	const message = event.data as ExtensionToWebview;

	if (message.type === 'tunnel-status') {
		tunnel = message.state;
	}

	if (message.type === 'key-fix-state') {
		keyFixEnabled = message.enabled;
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

export function getTunnelStore(): TunnelStore {
	const store: TunnelStore = {
		get tunnel() {
			return tunnel;
		},
		get keyFixEnabled() {
			return keyFixEnabled;
		},
		startTunnel,
		stopTunnel,
		restartTunnel,
		setKeyFixEnabled
	};

	return store;
}
