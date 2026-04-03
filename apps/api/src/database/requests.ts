import { eq } from 'drizzle-orm';

import { Pricing } from './pricing';
import { requests } from './schema';

import { getDb } from './index';

import type { RequestRecord } from '@ungate/shared';

export class Requests {
	static record(record: RequestRecord, cacheReadTokens?: number, cacheCreationTokens?: number): number {
		const db = getDb();
		const estimatedCost = Pricing.calculateCost(
			record.model,
			record.inputTokens,
			record.outputTokens,
			cacheReadTokens ?? 0,
			cacheCreationTokens ?? 0
		);

		const result = db
			.insert(requests)
			.values({
				timestamp: Date.now(),
				model: record.model,
				source: record.source,
				inputTokens: record.inputTokens,
				outputTokens: record.outputTokens,
				estimatedCost,
				stream: record.stream,
				latencyMs: record.latencyMs ?? null,
				error: record.error ?? null
			})
			.run();

		return result.lastInsertRowid as number;
	}

	static updateTokens(id: number, inputTokens: number, outputTokens: number): void {
		const db = getDb();
		const row = db.select({ model: requests.model }).from(requests).where(eq(requests.id, id)).get();

		if (!row) return;

		const estimatedCost = Pricing.calculateCost(row.model, inputTokens, outputTokens);

		db.update(requests).set({ inputTokens, outputTokens, estimatedCost }).where(eq(requests.id, id)).run();
	}
}
