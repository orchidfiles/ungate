import { describe, expect, it } from 'vitest';

import { getSqlite } from 'src/database';
import { Analytics } from 'src/database/analytics';
import { Requests } from 'src/database/requests';

import type { RequestRecord } from '@ungate/shared';

const BASE = Date.UTC(2026, 10, 2, 12, 0, 0);

function seedAccounts(): void {
	const sqlite = getSqlite();
	const insert = sqlite.prepare(
		`INSERT INTO oauth_accounts (id, provider, label, access_token, created_at, updated_at)
		 VALUES (?, ?, ?, 'token', 0, 0)`
	);
	insert.run('acct-a', 'claude', 'Account A');
	insert.run('acct-b', 'claude', 'Account B');
}

function row(minutes: number, overrides: Partial<RequestRecord>): void {
	const id = Requests.record({
		model: 'claude-opus-4-8',
		source: 'claude',
		inputTokens: 1000,
		outputTokens: 100,
		stream: true,
		latencyMs: 1000,
		stopReason: 'end_turn',
		...overrides
	});
	getSqlite()
		.prepare('UPDATE requests SET timestamp = ? WHERE id = ?')
		.run(BASE + minutes * 60_000, id);
}

describe('Analytics.getInsights', () => {
	it('aggregates telemetry for accounts, sessions, tools and continuations', () => {
		seedAccounts();
		// Legacy row from before telemetry: no cache split, no stop reason.
		row(-60, { inputTokens: 5000, stopReason: null });
		// Session s1 on account A: truncated, then continued; second turn hit a rotation.
		row(0, {
			sessionKey: 's1',
			turnIndex: 0,
			accountId: 'acct-a',
			attempts: 1,
			cacheReadTokens: 0,
			cacheCreationTokens: 800,
			stopReason: 'max_tokens',
			toolCallCount: 2,
			toolNames: ['Shell', 'Read'],
			reasoningTier: 'high',
			reasoningChars: 400,
			firstTokenMs: 300
		});
		row(1, {
			sessionKey: 's1',
			turnIndex: 1,
			inputTokens: 3000,
			accountId: 'acct-b',
			attempts: 2,
			rotationReason: 'five_hour',
			cacheReadTokens: 2400,
			cacheCreationTokens: 300,
			continuation: true,
			stopReason: 'tool_use',
			toolCallCount: 1,
			toolNames: ['Shell'],
			reasoningTier: 'high',
			firstTokenMs: 500
		});
		// Session s2 on account A with a user nudge after a normal stop.
		row(5, { sessionKey: 's2', turnIndex: 0, accountId: 'acct-a', cacheReadTokens: 0, cacheCreationTokens: 0 });
		row(6, {
			sessionKey: 's2',
			turnIndex: 1,
			accountId: 'acct-a',
			cacheReadTokens: 500,
			cacheCreationTokens: 0,
			continuation: true
		});
		// An upstream error.
		row(7, { source: 'error', error: 'Upstream 529: overloaded', stopReason: 'error', accountId: 'acct-b' });

		const insights = Analytics.getInsights('all', BASE - 3_600_000 * 2, BASE + 3_600_000);

		expect(insights.trackingSince).toBe(BASE);
		expect(insights.totals.requests).toBe(6);
		expect(insights.totals.trackedRequests).toBe(5);
		expect(insights.totals.rotatedRequests).toBe(1);
		// cache read 2400 + 500 over input of rows with a cache split (1000 + 3000 + 1000 + 1000).
		expect(insights.totals.cacheHitRate).toBeCloseTo(2900 / 6000);
		expect(insights.totals.sessions).toBe(2);
		expect(insights.totals.continuationRate).toBe(1);
		expect(insights.totals.poolBalance).not.toBeNull();

		const mix = insights.tokenMix[0];
		expect(mix.untrackedInput).toBe(5000 + 1000);
		expect(mix.cacheRead).toBe(2900);
		expect(mix.cacheWrite).toBe(1100);
		expect(mix.uncachedInput).toBe(200 + 300 + 1000 + 500);

		const [a, b] = ['acct-a', 'acct-b'].map((id) => insights.accounts.find((acct) => acct.accountId === id)!);
		expect(a.label).toBe('Account A');
		expect(a.requests).toBe(3);
		expect(b.requests).toBe(2);
		expect(b.errors).toBe(1);
		expect(b.rotatedIn).toBe(1);
		expect(a.share + b.share).toBeCloseTo(1);

		expect(insights.rotation.byReason).toEqual([{ key: 'five_hour', count: 1 }]);
		expect(insights.rotation.errorsByType).toEqual([{ key: 'Upstream N', count: 1 }]);

		expect(insights.tools.top).toEqual([
			{ key: 'Shell', count: 2 },
			{ key: 'Read', count: 1 }
		]);

		const s1 = insights.sessions.top.find((session) => session.sessionKey === 's1')!;
		expect(s1.turns).toBe(2);
		expect(s1.accounts).toBe(2);
		expect(s1.continuations).toBe(1);
		expect(s1.maxInputTokens).toBe(3000);
		expect(insights.sessions.turnsHistogram.find((bin) => bin.key === '2–5')?.count).toBe(2);
		// s1 grows 2000 tokens over one turn, s2 none: median 1000.
		expect(insights.sessions.medianGrowthPerTurn).toBe(1000);

		expect(insights.continuations.total).toBe(2);
		expect(Object.fromEntries(insights.continuations.byCause.map((c) => [c.key, c.count]))).toEqual({
			max_tokens: 1,
			nudge: 1
		});

		const high = insights.models.find((model) => model.reasoningTier === 'high')!;
		expect(high.requests).toBe(2);
		expect(high.reasoningChars).toBe(400);
		expect(high.firstTokenP50).toBe(300);
		expect(high.firstTokenP95).toBe(500);

		const stops = Object.fromEntries(insights.stopReasons.map((point) => [point.reason, point.count]));
		expect(stops).toEqual({ max_tokens: 1, tool_use: 1, end_turn: 2, error: 1 });
	});

	it('returns empty aggregates when nothing was recorded', () => {
		const insights = Analytics.getInsights('day', 0, Date.now());

		expect(insights.trackingSince).toBeNull();
		expect(insights.totals.cacheHitRate).toBeNull();
		expect(insights.totals.poolBalance).toBeNull();
		expect(insights.accounts).toEqual([]);
		expect(insights.sessions.top).toEqual([]);
		expect(insights.continuations.total).toBe(0);
	});
});
