export type Period = 'hour' | 'day' | 'week' | 'month' | 'all';

export type RequestSource = 'claude_code' | 'error';

export interface AnalyticsSummary {
	totalRequests: number;
	claudeCodeRequests: number;
	errorRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	periodStart: number;
	periodEnd: number;
	period: Period;
	note: string;
}

export interface RequestRecord {
	id: number;
	timestamp: number;
	model: string;
	source: RequestSource;
	inputTokens: number;
	outputTokens: number;
	estimatedCost: number;
	stream: boolean;
	latencyMs: number | null;
	error: string | null;
}

export interface AppSettings {
	port: number;
	apiKey: string | null;
	quiet: boolean;
	extraInstruction: string | null;
}

export interface LogEntry {
	timestamp: number;
	level: 'info' | 'warn' | 'error';
	message: string;
}

export interface TunnelState {
	status: 'stopped' | 'installing' | 'starting' | 'running' | 'error';
	url: string | null;
	error: string | null;
}

export type ExtensionToWebview =
	| { type: 'port'; port: number | null }
	| { type: 'tunnel-status'; state: TunnelState }
	| { type: 'log'; source: 'api' | 'tunnel'; entry: LogEntry }
	| { type: 'log-bulk'; source: 'api' | 'tunnel'; entries: LogEntry[] };

export type WebviewToExtension =
	| { type: 'webview-ready' }
	| { type: 'restart-server' }
	| { type: 'start-tunnel' }
	| { type: 'stop-tunnel' }
	| { type: 'restart-tunnel' };
