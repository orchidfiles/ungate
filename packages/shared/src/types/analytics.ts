export type Period = 'hour' | 'day' | 'week' | 'month' | 'all';

export type RequestSource = 'claude' | 'minimax' | 'openai' | 'cursor' | 'error';

export interface AnalyticsSummary {
	totalRequests: number;
	claudeRequests: number;
	minimaxRequests: number;
	openaiRequests: number;
	cursorRequests: number;
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
	/** Null means billing is unknown, not free (including all Cursor requests). */
	estimatedCost?: number | null;
	stream: boolean;
	latencyMs: number | null;
	error?: string | null;
	accountId?: string | null;
	attempts?: number | null;
	rotationReason?: string | null;
	cacheReadTokens?: number | null;
	cacheCreationTokens?: number | null;
	reasoningTokens?: number | null;
	/** Characters of streamed thinking text; an estimate where the provider reports no reasoning token count. */
	reasoningChars?: number | null;
	reasoningTier?: string | null;
	stopReason?: StopReason | null;
	toolCallCount?: number | null;
	toolNames?: string[] | null;
	sessionKey?: string | null;
	turnIndex?: number | null;
	messageCount?: number | null;
	continuation?: boolean | null;
	firstTokenMs?: number | null;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error' | 'aborted' | 'unknown';

/** Per-request telemetry fields gathered across the request lifecycle (router, account fallback, stream). */
export type RequestTelemetry = Omit<
	RequestRecord,
	'id' | 'timestamp' | 'model' | 'source' | 'inputTokens' | 'outputTokens' | 'estimatedCost' | 'stream' | 'latencyMs' | 'error'
>;

export interface TokenMixPoint {
	bucket: string;
	/** Input of requests with a cache split, excluding cache reads/writes. */
	uncachedInput: number;
	cacheRead: number;
	cacheWrite: number;
	/** Input of requests recorded without a cache split (before tracking, or provider did not report it). */
	untrackedInput: number;
	/** Visible output (output minus reported reasoning tokens). */
	output: number;
	reasoning: number;
	/** Requests in the bucket that carry the cache split (rows recorded before tracking began do not). */
	tracked: number;
	requests: number;
}

export interface CacheHitPoint {
	bucket: string;
	model: string;
	hitRate: number | null;
}

export interface AccountInsight {
	accountId: string;
	provider: string | null;
	label: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	/** Known-price subtotal; null when no requests have known pricing. */
	estimatedCost: number | null;
	/** Requests excluded from the subtotal because billing is unknown. */
	unknownCostRequests: number;
	errors: number;
	/** Requests this account served after another account hit its limit. */
	rotatedIn: number;
	/** Share of its provider's pool tokens in the period (0–1). */
	share: number;
	lastUsed: number | null;
}

export interface AccountSeriesPoint {
	bucket: string;
	accountId: string;
	tokens: number;
}

export interface RotationPoint {
	bucket: string;
	rotated: number;
	errors: number;
	continuations: number;
	requests: number;
}

export interface CountByKey {
	key: string;
	count: number;
}

export interface ModelInsight {
	model: string;
	reasoningTier: string | null;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	reasoningChars: number;
	cacheHitRate: number | null;
	latencyP50: number | null;
	latencyP95: number | null;
	firstTokenP50: number | null;
	firstTokenP95: number | null;
}

export interface SessionInsight {
	sessionKey: string;
	model: string;
	turns: number;
	requests: number;
	totalTokens: number;
	maxInputTokens: number;
	continuations: number;
	firstSeen: number;
	lastSeen: number;
	accounts: number;
	toolCalls: number;
}

export interface ContextGrowthPoint {
	turnIndex: number;
	medianInputTokens: number;
	samples: number;
}

export interface ContextSample {
	turnIndex: number;
	inputTokens: number;
}

export interface CauseSeriesPoint {
	bucket: string;
	cause: ContinuationCause;
	count: number;
}

/** Why work had to be continued: the previous request in the session ended truncated, errored, was cancelled, or the user nudged. */
export type ContinuationCause = 'max_tokens' | 'error' | 'aborted' | 'nudge';

export interface StopReasonPoint {
	bucket: string;
	reason: string;
	count: number;
}

export interface UsageInsights {
	period: Period;
	/** Earliest timestamp with extended telemetry, or null when none has been recorded yet. */
	trackingSince: number | null;
	totals: {
		requests: number;
		trackedRequests: number;
		cacheHitRate: number | null;
		sessions: number;
		avgTokensPerSession: number | null;
		continuationRate: number | null;
		poolBalance: number | null;
		rotatedRequests: number;
		avgToolCalls: number | null;
	};
	tokenMix: TokenMixPoint[];
	cacheHitRate: CacheHitPoint[];
	accounts: AccountInsight[];
	accountSeries: AccountSeriesPoint[];
	rotation: {
		series: RotationPoint[];
		byReason: CountByKey[];
		errorsByType: CountByKey[];
	};
	models: ModelInsight[];
	sessions: {
		top: SessionInsight[];
		turnsHistogram: CountByKey[];
		contextGrowth: ContextGrowthPoint[];
		contextSamples: ContextSample[];
		/** Median per-session input growth per turn (tokens), from first to last tracked turn. */
		medianGrowthPerTurn: number | null;
	};
	stopReasons: StopReasonPoint[];
	tools: {
		top: CountByKey[];
	};
	continuations: {
		total: number;
		sessionsWithContinuation: number;
		byCause: CountByKey[];
		series: CauseSeriesPoint[];
	};
}

export interface TokenSeriesPoint {
	bucket: string;
	inputTokens: number;
	outputTokens: number;
}
