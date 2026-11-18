import { and, desc, eq, lt } from 'drizzle-orm';

import { Pricing } from './pricing';
import { requests } from './schema';

import { getDb } from './index';

import type { RequestRecord } from '@ungate/shared';

const MAX_TOOL_NAMES = 32;

export class Requests {
	static record(record: RequestRecord): number {
		const db = getDb();
		// The legacy NOT NULL column requires a placeholder for Cursor. It is not a price:
		// analytics reads it as unknown via `unknownCostCondition`, including historical rows.
		const estimatedCost =
			record.source === 'cursor'
				? 0
				: Pricing.calculateCost(
						record.model,
						record.inputTokens,
						record.outputTokens,
						record.cacheReadTokens ?? 0,
						record.cacheCreationTokens ?? 0
					);
		const toolNames = record.toolNames?.length ? JSON.stringify(record.toolNames.slice(0, MAX_TOOL_NAMES)) : null;

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
				error: record.error ?? null,
				accountId: record.accountId ?? null,
				attempts: record.attempts ?? null,
				rotationReason: record.rotationReason ?? null,
				cacheReadTokens: record.cacheReadTokens ?? null,
				cacheCreationTokens: record.cacheCreationTokens ?? null,
				reasoningTokens: record.reasoningTokens ?? null,
				reasoningChars: record.reasoningChars ?? null,
				reasoningTier: record.reasoningTier ?? null,
				stopReason: record.stopReason ?? null,
				toolCallCount: record.toolCallCount ?? null,
				toolNames,
				sessionKey: record.sessionKey ?? null,
				turnIndex: record.turnIndex ?? null,
				messageCount: record.messageCount ?? null,
				continuation: record.continuation ?? null,
				firstTokenMs: record.firstTokenMs ?? null
			})
			.run();

		return result.lastInsertRowid as number;
	}

	/** Stop reason of the most recent earlier request in the same inferred agent session. */
	static lastStopReasonForSession(sessionKey: string, before: number = Date.now()): string | null {
		const row = getDb()
			.select({ stopReason: requests.stopReason, source: requests.source })
			.from(requests)
			.where(and(eq(requests.sessionKey, sessionKey), lt(requests.timestamp, before)))
			.orderBy(desc(requests.timestamp))
			.limit(1)
			.get();

		if (!row) return null;

		return row.stopReason ?? (row.source === 'error' ? 'error' : null);
	}

	static updateTokens(id: number, inputTokens: number, outputTokens: number): void {
		const db = getDb();
		const row = db.select({ model: requests.model, source: requests.source }).from(requests).where(eq(requests.id, id)).get();

		if (!row) return;

		const estimatedCost = row.source === 'cursor' ? 0 : Pricing.calculateCost(row.model, inputTokens, outputTokens);

		db.update(requests).set({ inputTokens, outputTokens, estimatedCost }).where(eq(requests.id, id)).run();
	}
}
