import type { ExtensionToWebview, LogEntry } from '@ungate/shared/frontend';

interface LogsStore {
	readonly apiLogs: LogEntry[];
	readonly tunnelLogs: LogEntry[];
	clearApi(): void;
	clearTunnel(): void;
	copyApi(): Promise<void>;
	copyTunnel(): Promise<void>;
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

async function copyApi(): Promise<void> {
	await navigator.clipboard.writeText(formatLogs(apiLogs));
}

async function copyTunnel(): Promise<void> {
	await navigator.clipboard.writeText(formatLogs(tunnelLogs));
}

function formatLogs(entries: LogEntry[]): string {
	return entries.map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.level}] ${entry.message}`).join('\n');
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
		clearTunnel,
		copyApi,
		copyTunnel
	};

	return store;
}
