import { postExtensionMessage } from '$shared/vscode';

import type { TunnelState, ExtensionToWebview } from '@ungate/shared/frontend';

interface TunnelStore {
	readonly tunnel: TunnelState;
	startTunnel(): void;
	stopTunnel(): void;
	restartTunnel(): void;
}

const defaultState: TunnelState = { status: 'stopped', url: null, error: null };

let tunnel = $state<TunnelState>({ ...defaultState });

function handleMessage(event: MessageEvent): void {
	const message = event.data as ExtensionToWebview;

	if (message.type === 'tunnel-status') {
		tunnel = message.state;
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

export function getTunnelStore(): TunnelStore {
	const store: TunnelStore = {
		get tunnel() {
			return tunnel;
		},
		startTunnel,
		stopTunnel,
		restartTunnel
	};

	return store;
}
