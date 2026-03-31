export type RequestSource = 'claude_code' | 'error';

export interface RequestRecord {
	model: string;
	source: RequestSource;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	stream: boolean;
	latencyMs?: number;
	error?: string;
}

export interface AnalyticsSummary {
	totalRequests: number;
	claudeCodeRequests: number;
	errorRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	periodStart: number;
	periodEnd: number;
}

export interface AppSettings {
	port: number;
	apiKey: string | null;
	quiet: boolean;
	extraInstruction: string | null;
}
