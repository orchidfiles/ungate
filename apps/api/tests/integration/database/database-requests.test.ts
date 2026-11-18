import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { getDb, schema } from 'src/database';
import { Analytics } from 'src/database/analytics';
import { Requests } from 'src/database/requests';

describe('database-requests', () => {
	it('keeps Cursor pricing unknown after recording and updating tokens', () => {
		const id = Requests.record({
			model: 'claude-sonnet-4-6',
			source: 'cursor',
			inputTokens: 10,
			outputTokens: 20,
			stream: true,
			latencyMs: null
		});
		expect(Analytics.getRecent().find((row) => row.id === id)?.estimatedCost).toBeNull();
		Requests.updateTokens(id, 100, 200);
		expect(Analytics.getRecent().find((row) => row.id === id)).toMatchObject({
			inputTokens: 100,
			outputTokens: 200,
			estimatedCost: null
		});
	});

	it('reports a failed request on a Cursor-routed model as unknown cost', () => {
		getDb()
			.insert(schema.modelMappings)
			.values({ id: 'ungate-grok-4.7-high', label: 'Grok', provider: 'cursor', upstreamModel: 'grok-4.7-high' })
			.run();
		const cursorFailure = Requests.record({
			model: 'ungate-grok-4.7-high',
			source: 'error',
			inputTokens: 0,
			outputTokens: 0,
			stream: false,
			latencyMs: 5,
			error: 'billing_blocked'
		});
		const otherFailure = Requests.record({
			model: 'claude-sonnet-4-6',
			source: 'error',
			inputTokens: 0,
			outputTokens: 0,
			stream: false,
			latencyMs: 5,
			error: 'boom'
		});

		const recent = Analytics.getRecent();
		expect(recent.find((row) => row.id === cursorFailure)?.estimatedCost).toBeNull();
		expect(recent.find((row) => row.id === otherFailure)?.estimatedCost).toBe(0);
	});

	it('records request with estimated cost and error field', () => {
		const id = Requests.record({
			model: 'claude-sonnet-4-6',
			source: 'claude',
			inputTokens: 10,
			outputTokens: 20,
			stream: false,
			latencyMs: null,
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
			stream: false,
			latencyMs: null
		});

		Requests.updateTokens(id, 100, 200);
		const row = getDb().select().from(schema.requests).where(eq(schema.requests.id, id)).get();
		expect(row?.inputTokens).toBe(100);
		expect(row?.outputTokens).toBe(200);
		expect(row?.estimatedCost).toBeTypeOf('number');
	});
});
