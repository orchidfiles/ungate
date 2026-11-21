import { unknownCostCondition } from './request-cost';

import type {
	AccountInsight,
	AccountSeriesPoint,
	CacheHitPoint,
	CauseSeriesPoint,
	ContextGrowthPoint,
	ContextSample,
	ContinuationCause,
	CountByKey,
	ModelInsight,
	Period,
	RotationPoint,
	SessionInsight,
	StopReasonPoint,
	TokenMixPoint,
	UsageInsights
} from '@ungate/shared';
import type { Database as DatabaseType } from 'better-sqlite3';

const TOP_SESSIONS = 20;
const TOP_TOOLS = 15;
const TOP_ERRORS = 10;
const MAX_TURN_FOR_GROWTH = 60;
const CONTEXT_SAMPLE_LIMIT = 1500;
/** Latency percentiles are computed over at most this many recent rows per model/tier. */
const LATENCY_SAMPLE_LIMIT = 2000;
const TURN_BINS: { key: string; max: number }[] = [
	{ key: '1', max: 1 },
	{ key: '2–5', max: 5 },
	{ key: '6–10', max: 10 },
	{ key: '11–25', max: 25 },
	{ key: '26–50', max: 50 },
	{ key: '51–100', max: 100 },
	{ key: '100+', max: Number.POSITIVE_INFINITY }
];

/** Rows written after migration `_0012` carry `stop_reason`; older rows are "not tracked". */
const TRACKED = 'stop_reason IS NOT NULL';

export function bucketSql(period: Period): string {
	const ts = "datetime(timestamp / 1000, 'unixepoch')";

	if (period === 'hour') return `strftime('%Y-%m-%d %H:%M', ${ts})`;
	if (period === 'day') return `strftime('%Y-%m-%d %H:00', ${ts})`;

	return `strftime('%Y-%m-%d', ${ts})`;
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));

	return sorted[index];
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);

	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 1 − Gini over token shares: 1 = perfectly even pool, → 0 = one account does all the work. */
export function poolBalance(tokens: number[]): number | null {
	const values = tokens.filter((value) => value >= 0);
	const total = values.reduce((sum, value) => sum + value, 0);
	if (values.length < 2 || total === 0) return null;

	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const weighted = sorted.reduce((sum, value, index) => sum + (index + 1) * value, 0);
	const gini = (2 * weighted) / (n * total) - (n + 1) / n;
	// Normalize so the maximum possible Gini for n accounts ((n-1)/n) maps to 0.
	const normalized = gini / ((n - 1) / n);

	return Math.max(0, Math.min(1, 1 - normalized));
}

/** Groups error text by its leading phrase (before ':' / '(' / digits) so similar errors aggregate. */
export function errorKey(error: string): string {
	const head = error
		.split(/[:(\n]/)[0]
		.replace(/\b\d[\d.,]*\b/g, 'N')
		.replace(/\s+/g, ' ')
		.trim();

	return (head || 'error').slice(0, 80);
}

interface Range {
	since: number;
	until: number;
}

export class UsageInsightsQuery {
	constructor(
		private readonly sqlite: DatabaseType,
		private readonly period: Period,
		private readonly range: Range
	) {}

	run(): UsageInsights {
		const accounts = this.accounts();
		const sessions = this.sessions();
		const continuations = this.continuations();
		const totals = this.totals();
		const providerTokens = new Map<string, number[]>();

		for (const account of accounts) {
			const key = account.provider ?? 'unknown';
			providerTokens.set(key, [...(providerTokens.get(key) ?? []), account.inputTokens + account.outputTokens]);
		}

		// Balance of the largest pool (by account count) is the headline; per-provider pools are not mixed.
		const largestPool = [...providerTokens.values()].sort((a, b) => b.length - a.length)[0] ?? [];

		return {
			period: this.period,
			trackingSince: this.trackingSince(),
			totals: {
				requests: totals.requests,
				trackedRequests: totals.tracked,
				cacheHitRate: totals.cacheInput > 0 ? totals.cacheRead / totals.cacheInput : null,
				sessions: sessions.count,
				avgTokensPerSession: sessions.count > 0 ? sessions.totalTokens / sessions.count : null,
				continuationRate: sessions.count > 0 ? continuations.sessionsWithContinuation / sessions.count : null,
				poolBalance: poolBalance(largestPool),
				rotatedRequests: totals.rotated,
				avgToolCalls: totals.tracked > 0 ? totals.toolCalls / totals.tracked : null
			},
			tokenMix: this.tokenMix(),
			cacheHitRate: this.cacheHitRate(),
			accounts,
			accountSeries: this.accountSeries(),
			rotation: {
				series: this.rotationSeries(),
				byReason: this.rotationReasons(),
				errorsByType: this.errorsByType()
			},
			models: this.models(),
			sessions: {
				top: sessions.top,
				turnsHistogram: sessions.histogram,
				contextGrowth: this.contextGrowth(),
				contextSamples: this.contextSamples(),
				medianGrowthPerTurn: sessions.medianGrowthPerTurn
			},
			stopReasons: this.stopReasons(),
			tools: { top: this.topTools() },
			continuations
		};
	}

	private where(extra?: string): string {
		return `timestamp >= @since AND timestamp <= @until${extra ? ` AND ${extra}` : ''}`;
	}

	private all<T>(query: string): T[] {
		return this.sqlite.prepare(query).all(this.range) as T[];
	}

	private get<T>(query: string): T | undefined {
		return this.sqlite.prepare(query).get(this.range) as T | undefined;
	}

	private trackingSince(): number | null {
		const row = this.sqlite.prepare(`SELECT MIN(timestamp) AS ts FROM requests WHERE ${TRACKED}`).get() as {
			ts: number | null;
		};

		return row?.ts ?? null;
	}

	private totals() {
		const row = this.get<{
			requests: number;
			tracked: number | null;
			cacheRead: number | null;
			cacheInput: number | null;
			rotated: number | null;
			toolCalls: number | null;
		}>(`
			SELECT
				COUNT(*) AS requests,
				SUM(CASE WHEN ${TRACKED} THEN 1 ELSE 0 END) AS tracked,
				SUM(CASE WHEN cache_read_tokens IS NOT NULL THEN cache_read_tokens ELSE 0 END) AS cacheRead,
				SUM(CASE WHEN cache_read_tokens IS NOT NULL THEN input_tokens ELSE 0 END) AS cacheInput,
				SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS rotated,
				SUM(COALESCE(tool_call_count, 0)) AS toolCalls
			FROM requests WHERE ${this.where()}
		`);

		return {
			requests: row?.requests ?? 0,
			tracked: row?.tracked ?? 0,
			cacheRead: row?.cacheRead ?? 0,
			cacheInput: row?.cacheInput ?? 0,
			rotated: row?.rotated ?? 0,
			toolCalls: row?.toolCalls ?? 0
		};
	}

	private tokenMix(): TokenMixPoint[] {
		return this.all<TokenMixPoint>(`
			SELECT
				${bucketSql(this.period)} AS bucket,
				SUM(CASE WHEN cache_read_tokens IS NOT NULL
					THEN MAX(input_tokens - cache_read_tokens - COALESCE(cache_creation_tokens, 0), 0) ELSE 0 END) AS uncachedInput,
				SUM(COALESCE(cache_read_tokens, 0)) AS cacheRead,
				SUM(COALESCE(cache_creation_tokens, 0)) AS cacheWrite,
				SUM(CASE WHEN cache_read_tokens IS NULL THEN input_tokens ELSE 0 END) AS untrackedInput,
				SUM(MAX(output_tokens - COALESCE(reasoning_tokens, 0), 0)) AS output,
				SUM(COALESCE(reasoning_tokens, 0)) AS reasoning,
				SUM(CASE WHEN cache_read_tokens IS NOT NULL THEN 1 ELSE 0 END) AS tracked,
				COUNT(*) AS requests
			FROM requests WHERE ${this.where()}
			GROUP BY bucket ORDER BY bucket ASC
		`);
	}

	private cacheHitRate(): CacheHitPoint[] {
		const rows = this.all<{ bucket: string; model: string; cacheRead: number; input: number }>(`
			SELECT ${bucketSql(this.period)} AS bucket, model,
				SUM(cache_read_tokens) AS cacheRead, SUM(input_tokens) AS input
			FROM requests WHERE ${this.where('cache_read_tokens IS NOT NULL')}
			GROUP BY bucket, model ORDER BY bucket ASC
		`);

		return rows.map((row) => ({
			bucket: row.bucket,
			model: row.model,
			hitRate: row.input > 0 ? row.cacheRead / row.input : null
		}));
	}

	private accounts(): AccountInsight[] {
		const rows = this.all<{
			accountId: string;
			provider: string | null;
			label: string | null;
			requests: number;
			inputTokens: number;
			outputTokens: number;
			estimatedCost: number | null;
			unknownCostRequests: number;
			errors: number;
			rotatedIn: number;
			lastUsed: number | null;
		}>(`
			SELECT r.account_id AS accountId, a.provider AS provider, a.label AS label,
				COUNT(*) AS requests,
				SUM(r.input_tokens) AS inputTokens,
				SUM(r.output_tokens) AS outputTokens,
				SUM(CASE WHEN NOT ${unknownCostCondition('r')} THEN r.estimated_cost END) AS estimatedCost,
				SUM(CASE WHEN ${unknownCostCondition('r')} THEN 1 ELSE 0 END) AS unknownCostRequests,
				SUM(CASE WHEN r.source = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN r.attempts > 1 THEN 1 ELSE 0 END) AS rotatedIn,
				MAX(r.timestamp) AS lastUsed
			FROM requests r LEFT JOIN oauth_accounts a ON a.id = r.account_id
			WHERE r.account_id IS NOT NULL AND r.timestamp >= @since AND r.timestamp <= @until
			GROUP BY r.account_id
			ORDER BY inputTokens + outputTokens DESC
		`);
		const poolTotals = new Map<string, number>();

		for (const row of rows) {
			const key = row.provider ?? 'unknown';
			poolTotals.set(key, (poolTotals.get(key) ?? 0) + row.inputTokens + row.outputTokens);
		}

		return rows.map((row) => {
			const pool = poolTotals.get(row.provider ?? 'unknown') ?? 0;

			return {
				...row,
				label: row.label ?? `${row.accountId} (removed)`,
				share: pool > 0 ? (row.inputTokens + row.outputTokens) / pool : 0
			};
		});
	}

	private accountSeries(): AccountSeriesPoint[] {
		return this.all<AccountSeriesPoint>(`
			SELECT ${bucketSql(this.period)} AS bucket, account_id AS accountId, SUM(input_tokens + output_tokens) AS tokens
			FROM requests WHERE ${this.where('account_id IS NOT NULL')}
			GROUP BY bucket, account_id ORDER BY bucket ASC
		`);
	}

	private rotationSeries(): RotationPoint[] {
		return this.all<RotationPoint>(`
			SELECT ${bucketSql(this.period)} AS bucket,
				SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) AS rotated,
				SUM(CASE WHEN source = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN continuation = 1 THEN 1 ELSE 0 END) AS continuations,
				COUNT(*) AS requests
			FROM requests WHERE ${this.where()}
			GROUP BY bucket ORDER BY bucket ASC
		`);
	}

	private rotationReasons(): CountByKey[] {
		return this.all<CountByKey>(`
			SELECT COALESCE(rotation_reason, 'unknown') AS key, COUNT(*) AS count
			FROM requests WHERE ${this.where("attempts > 1 OR (rotation_reason IS NOT NULL AND source = 'error')")}
			GROUP BY key ORDER BY count DESC
		`);
	}

	private errorsByType(): CountByKey[] {
		const rows = this.all<{ error: string; count: number }>(`
			SELECT error, COUNT(*) AS count FROM requests
			WHERE ${this.where("source = 'error' AND error IS NOT NULL")}
			GROUP BY error
		`);
		const grouped = new Map<string, number>();

		for (const row of rows) {
			const key = errorKey(row.error);
			grouped.set(key, (grouped.get(key) ?? 0) + row.count);
		}

		return [...grouped.entries()]
			.map(([key, count]) => ({ key, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, TOP_ERRORS);
	}

	private models(): ModelInsight[] {
		const rows = this.all<{
			model: string;
			reasoningTier: string | null;
			requests: number;
			inputTokens: number;
			outputTokens: number;
			reasoningTokens: number;
			reasoningChars: number;
			cacheRead: number | null;
			cacheInput: number | null;
		}>(`
			SELECT model, reasoning_tier AS reasoningTier, COUNT(*) AS requests,
				SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
				SUM(COALESCE(reasoning_tokens, 0)) AS reasoningTokens,
				SUM(COALESCE(reasoning_chars, 0)) AS reasoningChars,
				SUM(cache_read_tokens) AS cacheRead,
				SUM(CASE WHEN cache_read_tokens IS NOT NULL THEN input_tokens END) AS cacheInput
			FROM requests WHERE ${this.where("source != 'error'")}
			GROUP BY model, reasoning_tier
			ORDER BY inputTokens + outputTokens DESC
		`);
		const latencyStmt = this.sqlite.prepare(`
			SELECT latency_ms AS latency, first_token_ms AS firstToken FROM requests
			WHERE ${this.where("source != 'error'")} AND model = @model AND reasoning_tier IS @tier
			ORDER BY timestamp DESC LIMIT ${LATENCY_SAMPLE_LIMIT}
		`);

		return rows.map((row) => {
			const samples = latencyStmt.all({ ...this.range, model: row.model, tier: row.reasoningTier }) as {
				latency: number | null;
				firstToken: number | null;
			}[];
			const latencies = samples.flatMap((s) => (s.latency == null ? [] : [s.latency])).sort((a, b) => a - b);
			const firstTokens = samples.flatMap((s) => (s.firstToken == null ? [] : [s.firstToken])).sort((a, b) => a - b);

			return {
				model: row.model,
				reasoningTier: row.reasoningTier,
				requests: row.requests,
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				reasoningTokens: row.reasoningTokens,
				reasoningChars: row.reasoningChars,
				cacheHitRate: row.cacheInput ? (row.cacheRead ?? 0) / row.cacheInput : null,
				latencyP50: percentile(latencies, 0.5),
				latencyP95: percentile(latencies, 0.95),
				firstTokenP50: percentile(firstTokens, 0.5),
				firstTokenP95: percentile(firstTokens, 0.95)
			};
		});
	}

	private sessions(): {
		count: number;
		totalTokens: number;
		top: SessionInsight[];
		histogram: CountByKey[];
		medianGrowthPerTurn: number | null;
	} {
		const rows = this.all<SessionInsight & { firstInput: number; lastInput: number; minTurn: number; maxTurn: number }>(`
			WITH s AS (
				SELECT session_key,
					COUNT(*) AS requests,
					MAX(turn_index) + 1 AS turns,
					MIN(turn_index) AS minTurn,
					MAX(turn_index) AS maxTurn,
					SUM(input_tokens + output_tokens) AS totalTokens,
					MAX(input_tokens) AS maxInputTokens,
					SUM(CASE WHEN continuation = 1 THEN 1 ELSE 0 END) AS continuations,
					MIN(timestamp) AS firstSeen,
					MAX(timestamp) AS lastSeen,
					COUNT(DISTINCT account_id) AS accounts,
					SUM(COALESCE(tool_call_count, 0)) AS toolCalls
				FROM requests WHERE ${this.where('session_key IS NOT NULL')}
				GROUP BY session_key
			)
			SELECT s.session_key AS sessionKey, s.*,
				(SELECT model FROM requests r WHERE r.session_key = s.session_key AND r.timestamp = s.lastSeen LIMIT 1) AS model,
				(SELECT input_tokens FROM requests r WHERE r.session_key = s.session_key AND r.timestamp = s.firstSeen LIMIT 1) AS firstInput,
				(SELECT input_tokens FROM requests r WHERE r.session_key = s.session_key AND r.timestamp = s.lastSeen LIMIT 1) AS lastInput
			FROM s
			ORDER BY s.totalTokens DESC
		`);
		const histogram = TURN_BINS.map((bin) => ({ key: bin.key, count: 0 }));
		const growth: number[] = [];
		let totalTokens = 0;

		for (const row of rows) {
			totalTokens += row.totalTokens;
			const bin = TURN_BINS.findIndex((candidate) => row.turns <= candidate.max);
			histogram[bin === -1 ? histogram.length - 1 : bin].count++;
			if (row.maxTurn > row.minTurn) growth.push((row.lastInput - row.firstInput) / (row.maxTurn - row.minTurn));
		}

		return {
			count: rows.length,
			totalTokens,
			top: rows.slice(0, TOP_SESSIONS).map((row) => ({
				sessionKey: row.sessionKey,
				model: row.model,
				turns: row.turns,
				requests: row.requests,
				totalTokens: row.totalTokens,
				maxInputTokens: row.maxInputTokens,
				continuations: row.continuations,
				firstSeen: row.firstSeen,
				lastSeen: row.lastSeen,
				accounts: row.accounts,
				toolCalls: row.toolCalls
			})),
			histogram,
			medianGrowthPerTurn: median(growth)
		};
	}

	private contextGrowth(): ContextGrowthPoint[] {
		const rows = this.all<{ turnIndex: number; inputTokens: number }>(`
			SELECT turn_index AS turnIndex, input_tokens AS inputTokens FROM requests
			WHERE ${this.where(`turn_index IS NOT NULL AND turn_index <= ${MAX_TURN_FOR_GROWTH} AND source != 'error' AND input_tokens > 0`)}
		`);
		const byTurn = new Map<number, number[]>();

		for (const row of rows) {
			byTurn.set(row.turnIndex, [...(byTurn.get(row.turnIndex) ?? []), row.inputTokens]);
		}

		return [...byTurn.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([turnIndex, values]) => ({ turnIndex, medianInputTokens: median(values) ?? 0, samples: values.length }));
	}

	private contextSamples(): ContextSample[] {
		return this.all<ContextSample>(`
			SELECT turn_index AS turnIndex, input_tokens AS inputTokens FROM requests
			WHERE ${this.where("turn_index IS NOT NULL AND source != 'error' AND input_tokens > 0")}
			ORDER BY timestamp DESC LIMIT ${CONTEXT_SAMPLE_LIMIT}
		`);
	}

	private stopReasons(): StopReasonPoint[] {
		return this.all<StopReasonPoint>(`
			SELECT ${bucketSql(this.period)} AS bucket, stop_reason AS reason, COUNT(*) AS count
			FROM requests WHERE ${this.where(TRACKED)}
			GROUP BY bucket, stop_reason ORDER BY bucket ASC
		`);
	}

	private topTools(): CountByKey[] {
		return this.all<CountByKey>(`
			SELECT j.value AS key, COUNT(*) AS count
			FROM requests r, json_each(r.tool_names) j
			WHERE r.tool_names IS NOT NULL AND r.timestamp >= @since AND r.timestamp <= @until
			GROUP BY j.value ORDER BY count DESC LIMIT ${TOP_TOOLS}
		`);
	}

	/**
	 * A continuation's cause is the previous request in its session: truncated (`max_tokens`),
	 * failed (`error`) or cancelled (`aborted`); otherwise the user nudged ("continue") after a
	 * normal stop.
	 */
	private continuations(): UsageInsights['continuations'] {
		const rows = this.all<{ bucket: string; sessionKey: string | null; previous: string | null }>(`
			WITH ordered AS (
				SELECT timestamp, session_key, continuation,
					LAG(stop_reason) OVER (PARTITION BY session_key ORDER BY timestamp) AS previous
				FROM requests
				WHERE session_key IS NOT NULL AND timestamp <= @until
			)
			SELECT ${bucketSql(this.period)} AS bucket, session_key AS sessionKey, previous
			FROM ordered
			WHERE continuation = 1 AND timestamp >= @since
			ORDER BY timestamp ASC
		`);
		const byCause = new Map<ContinuationCause, number>();
		const series = new Map<string, CauseSeriesPoint>();
		const sessions = new Set<string>();

		for (const row of rows) {
			const cause: ContinuationCause =
				row.previous === 'max_tokens' || row.previous === 'error' || row.previous === 'aborted' ? row.previous : 'nudge';
			byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
			const key = `${row.bucket}|${cause}`;
			const point = series.get(key) ?? { bucket: row.bucket, cause, count: 0 };
			point.count++;
			series.set(key, point);
			if (row.sessionKey) sessions.add(row.sessionKey);
		}

		return {
			total: rows.length,
			sessionsWithContinuation: sessions.size,
			byCause: [...byCause.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
			series: [...series.values()]
		};
	}
}
