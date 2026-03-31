import type { ExtensionToWebview, LogEntry } from '@ungate/shared/frontend';

interface LogsStore {
	readonly apiLogs: LogEntry[];
	readonly tunnelLogs: LogEntry[];
	clearApi(): void;
	clearTunnel(): void;
}

let apiLogs = $state<LogEntry[]>([]);
let tunnelLogs = $state<LogEntry[]>([]);

function handleMessage(event: MessageEvent): void {
	const message = event.data as ExtensionToWebview;

	if (message.type === 'log') {
		if (message.source === 'api') {
			apiLogs = [...apiLogs, message.entry];
		} else {
			tunnelLogs = [...tunnelLogs, message.entry];
		}
	}

	if (message.type === 'log-bulk') {
		if (message.source === 'api') {
			apiLogs = [...apiLogs, ...message.entries];
		} else {
			tunnelLogs = [...tunnelLogs, ...message.entries];
		}
	}
}

window.addEventListener('message', handleMessage);

function clearApi(): void {
	apiLogs = [];
}

function clearTunnel(): void {
	tunnelLogs = [];
}

export function getLogsStore(): LogsStore {
	const store: LogsStore = {
		get apiLogs() {
			return apiLogs;
		},
		get tunnelLogs() {
			return tunnelLogs;
		},
		clearApi,
		clearTunnel
	};

	return store;
}
