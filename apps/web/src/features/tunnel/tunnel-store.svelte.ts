import type { TunnelState, ExtensionToWebview, WebviewToExtension } from '@ungate/shared/frontend';

interface TunnelStore {
	readonly tunnel: TunnelState;
	startTunnel(): void;
	stopTunnel(): void;
	restartTunnel(): void;
}

const defaultState: TunnelState = { status: 'stopped', url: null, error: null };

let tunnel = $state<TunnelState>({ ...defaultState });

function postMessage(message: WebviewToExtension): void {
	const vscode = (window as Window & { acquireVsCodeApi?: () => { postMessage: (msg: unknown) => void } }).acquireVsCodeApi;

	if (vscode) {
		vscode().postMessage(message);
	}
}

function handleMessage(event: MessageEvent): void {
	const message = event.data as ExtensionToWebview;

	if (message.type === 'tunnel-status') {
		tunnel = message.state;
	}
}

window.addEventListener('message', handleMessage);

function startTunnel(): void {
	postMessage({ type: 'start-tunnel' });
}

function stopTunnel(): void {
	postMessage({ type: 'stop-tunnel' });
}

function restartTunnel(): void {
	postMessage({ type: 'restart-tunnel' });
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
