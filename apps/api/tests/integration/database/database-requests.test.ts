import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { getDb, schema } from 'src/database';
import { Requests } from 'src/database/requests';

describe('database-requests', () => {
	it('records request with estimated cost and error field', () => {
		const id = Requests.record({
			model: 'claude-sonnet-4-6',
			source: 'claude',
			inputTokens: 10,
			outputTokens: 20,
			stream: false,
			error: 'boom'
		});

		expect(id).toBeGreaterThan(0);
		const row = getDb().select().from(schema.requests).where(eq(schema.requests.id, id)).get();
		expect(row?.model).toBe('claude-sonnet-4-6');
		expect(row?.estimatedCost).toBeTypeOf('number');
		expect(row?.error).toBe('boom');
	});

	it('updates tokens and recalculates cost', () => {
		const id = Requests.record({
			model: 'claude-sonnet-4-6',
			source: 'claude',
			inputTokens: 1,
			outputTokens: 2,
			stream: false
		});

		Requests.updateTokens(id, 100, 200);
		const row = getDb().select().from(schema.requests).where(eq(schema.requests.id, id)).get();
		expect(row?.inputTokens).toBe(100);
		expect(row?.outputTokens).toBe(200);
		expect(row?.estimatedCost).toBeTypeOf('number');
	});
});
