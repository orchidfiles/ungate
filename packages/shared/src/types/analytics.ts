export type Period = 'hour' | 'day' | 'week' | 'month' | 'all';

export type RequestSource = 'claude' | 'minimax' | 'error';

export interface AnalyticsSummary {
	totalRequests: number;
	claudeCodeRequests: number;
	errorRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	periodStart: number;
	periodEnd: number;
	period?: Period;
	note?: string;
}

export interface RequestRecord {
	id?: number;
	timestamp?: number;
	model: string;
	source: RequestSource;
	inputTokens: number;
	outputTokens: number;
	estimatedCost?: number;
	stream: boolean;
	latencyMs: number | null;
	error?: string | null;
}
