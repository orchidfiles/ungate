import { sql } from 'drizzle-orm';

import { logger } from 'src/utils/logger';

import { requests } from './schema';

import { getDb } from './index';

import type { AnalyticsSummary } from '../types';

export class Analytics {
	static getSummary(since: number, until: number = Date.now()): AnalyticsSummary {
		const db = getDb();

		const totals = db
			.select({
				totalRequests: sql<number>`COUNT(*)`,
				claudeCodeRequests: sql<number>`SUM(CASE WHEN ${requests.source} = 'claude_code' THEN 1 ELSE 0 END)`,
				errorRequests: sql<number>`SUM(CASE WHEN ${requests.source} = 'error' THEN 1 ELSE 0 END)`,
				totalInputTokens: sql<number>`SUM(${requests.inputTokens})`,
				totalOutputTokens: sql<number>`SUM(${requests.outputTokens})`
			})
			.from(requests)
			.where(sql`${requests.timestamp} >= ${since} AND ${requests.timestamp} <= ${until}`)
			.get();

		return {
			totalRequests: totals?.totalRequests ?? 0,
			claudeCodeRequests: totals?.claudeCodeRequests ?? 0,
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
			.select()
			.from(requests)
			.orderBy(sql`${requests.timestamp} DESC`)
			.limit(limit)
			.all()
			.map((row) => ({
				id: row.id,
				timestamp: row.timestamp,
				model: row.model,
				source: row.source,
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				estimatedCost: row.estimatedCost,
				stream: row.stream,
				latencyMs: row.latencyMs,
				error: row.error
			}));
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
