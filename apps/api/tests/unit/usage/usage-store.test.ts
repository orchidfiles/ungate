import { beforeEach, describe, expect, it } from 'vitest';

import { AccountUsageStore } from 'src/usage/usage-store';

const NOW = 1_800_000_000_000;

beforeEach(() => AccountUsageStore.clear());

describe('AccountUsageStore', () => {
	it('merges header updates without dropping endpoint-only windows', () => {
		AccountUsageStore.recordEndpoint(
			'a',
			[
				{ id: '7d_opus', label: 'Weekly (Opus)', usedPercent: 5, resetsAt: null, windowMinutes: 10080 },
				{ id: '5h', label: '5-hour', usedPercent: 10, resetsAt: null, windowMinutes: 300 }
			],
			null,
			NOW
		);
		AccountUsageStore.recordHeaders('claude', 'a', new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }), NOW + 1);

		const usage = AccountUsageStore.get('a')!;
		expect(usage.source).toBe('headers');
		expect(usage.updatedAt).toBe(NOW + 1);
		expect(usage.windows.map((window) => [window.id, window.usedPercent])).toEqual([
			['5h', 50],
			['7d_opus', 5]
		]);
	});

	it('ignores responses without usage headers', () => {
		AccountUsageStore.recordHeaders('openai', 'a', new Headers({ 'content-type': 'text/event-stream' }), NOW);
		expect(AccountUsageStore.get('a')).toBeUndefined();
	});

	it('keeps windows and plan on errors, clears the error on the next success, and deletes', () => {
		AccountUsageStore.recordHeaders(
			'openai',
			'a',
			new Headers({ 'x-codex-primary-used-percent': '20', 'x-codex-plan-type': 'plus' }),
			NOW
		);
		AccountUsageStore.recordError('a', 'Usage request failed (HTTP 500)', NOW + 5);
		expect(AccountUsageStore.get('a')).toMatchObject({
			planType: 'plus',
			error: 'Usage request failed (HTTP 500)',
			updatedAt: NOW,
			windows: [{ id: 'primary', usedPercent: 20 }]
		});

		AccountUsageStore.recordEndpoint('a', [], null, NOW + 10);
		expect(AccountUsageStore.get('a')).toMatchObject({ planType: 'plus', error: null, source: 'endpoint' });

		AccountUsageStore.delete('a');
		expect(AccountUsageStore.get('a')).toBeUndefined();
	});

	it('records an error for an account with no prior usage', () => {
		AccountUsageStore.recordError('b', 'boom', NOW);
		expect(AccountUsageStore.get('b')).toEqual({
			windows: [],
			planType: null,
			source: 'endpoint',
			updatedAt: NOW,
			error: 'boom'
		});
	});
});
