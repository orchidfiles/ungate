import { sql } from 'drizzle-orm';

import { logger } from 'src/utils/logger';

import { UsageInsightsQuery } from './insights';
import { unknownCostCondition } from './request-cost';
import { requests } from './schema';

import { getDb, getSqlite } from './index';

import type { AnalyticsSummary, Period, TokenSeriesPoint, UsageInsights } from '@ungate/shared';

export class Analytics {
	static getSummary(since: number, until: number = Date.now()): AnalyticsSummary {
		const db = getDb();

		const totals = db
			.select({
				totalRequests: sql<number>`COUNT(*)`,
				claudeRequests: sql<number>`SUM(CASE WHEN ${requests.source} = 'claude' THEN 1 ELSE 0 END)`,
				minimaxRequests: sql<number>`SUM(CASE WHEN ${requests.source} = 'minimax' THEN 1 ELSE 0 END)`,
				openaiRequests: sql<number>`SUM(CASE WHEN ${requests.source} = 'openai' THEN 1 ELSE 0 END)`,
				cursorRequests: sql<number>`SUM(CASE WHEN ${requests.source} = 'cursor' THEN 1 ELSE 0 END)`,
				errorRequests: sql<number>`SUM(CASE WHEN ${requests.source} = 'error' THEN 1 ELSE 0 END)`,
				totalInputTokens: sql<number>`SUM(${requests.inputTokens})`,
				totalOutputTokens: sql<number>`SUM(${requests.outputTokens})`
			})
			.from(requests)
			.where(sql`${requests.timestamp} >= ${since} AND ${requests.timestamp} <= ${until}`)
			.get();

		return {
			totalRequests: totals?.totalRequests ?? 0,
			claudeRequests: totals?.claudeRequests ?? 0,
			minimaxRequests: totals?.minimaxRequests ?? 0,
			openaiRequests: totals?.openaiRequests ?? 0,
			cursorRequests: totals?.cursorRequests ?? 0,
			errorRequests: totals?.errorRequests ?? 0,
			totalInputTokens: totals?.totalInputTokens ?? 0,
			totalOutputTokens: totals?.totalOutputTokens ?? 0,
			periodStart: since,
			periodEnd: until
		};
	}

	static getRecent(limit = 100) {
		const db = getDb();

		return db
			.select({ row: requests, unknownCost: sql<number>`${sql.raw(unknownCostCondition())}` })
			.from(requests)
			.orderBy(sql`${requests.timestamp} DESC`)
			.limit(limit)
			.all()
			.map(({ row, unknownCost }) => ({
				id: row.id,
				timestamp: row.timestamp,
				model: row.model,
				source: row.source,
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				// Computed per read, so historical rows stored with a zero placeholder stay unknown.
				estimatedCost: unknownCost ? null : row.estimatedCost,
				stream: row.stream,
				latencyMs: row.latencyMs,
				error: row.error
			}));
	}

	static getTokenSeries(period: Period, since: number, until: number = Date.now()): TokenSeriesPoint[] {
		const db = getDb();
		const bucketExpr = this.bucketExpression(period);

		const rows = db
			.select({
				bucket: sql<string>`${bucketExpr}`,
				inputTokens: sql<number>`SUM(${requests.inputTokens})`,
				outputTokens: sql<number>`SUM(${requests.outputTokens})`
			})
			.from(requests)
			.where(sql`${requests.timestamp} >= ${since} AND ${requests.timestamp} <= ${until}`)
			.groupBy(sql`${bucketExpr}`)
			.orderBy(sql`${bucketExpr} ASC`)
			.all();

		return rows.map((row) => ({
			bucket: row.bucket,
			inputTokens: row.inputTokens ?? 0,
			outputTokens: row.outputTokens ?? 0
		}));
	}

	/** Usage heuristics over the period; see `UsageInsightsQuery` for each aggregate. */
	static getInsights(period: Period, since: number, until: number = Date.now()): UsageInsights {
		return new UsageInsightsQuery(getSqlite(), period, { since, until }).run();
	}

	private static bucketExpression(period: Period) {
		const timestampSeconds = sql`(${requests.timestamp} / 1000)`;

		if (period === 'hour') {
			return sql`strftime('%Y-%m-%d %H:%M', datetime(${timestampSeconds}, 'unixepoch'))`;
		}

		if (period === 'day') {
			return sql`strftime('%Y-%m-%d %H:00', datetime(${timestampSeconds}, 'unixepoch'))`;
		}

		return sql`strftime('%Y-%m-%d', datetime(${timestampSeconds}, 'unixepoch'))`;
	}

	static reset(): { deletedCount: number } {
		const db = getDb();
		const countResult = db
			.select({ count: sql<number>`COUNT(*)` })
			.from(requests)
			.get();
		const deletedCount = countResult?.count ?? 0;

		db.delete(requests).run();

		logger.log(`✓ Reset analytics: deleted ${deletedCount} records`);

		return { deletedCount };
	}
}
