import { describe, expect, it } from 'vitest';

import { AccountFallback } from 'src/proxy/account-fallback';

const NOW = 1_800_000_000_000;

describe('AccountFallback.limitHeaders (pool-wide 429)', () => {
	it('Claude, reset far away: rejected + reset in epoch seconds + x-should-retry false', () => {
		const retryAt = NOW + 3_600_500;

		expect(AccountFallback.limitHeaders('claude', { 'x-should-retry': 'true' }, retryAt, NOW)).toEqual({
			'retry-after': '3601',
			'anthropic-ratelimit-unified-status': 'rejected',
			'anthropic-ratelimit-unified-reset': String(Math.ceil(retryAt / 1000)),
			'x-should-retry': 'false'
		});
	});

	it('Claude, reset soon: retries stay allowed (upstream hint kept)', () => {
		const headers = AccountFallback.limitHeaders('claude', { 'x-should-retry': 'true' }, NOW + 30_000, NOW);

		expect(headers['retry-after']).toBe('30');
		expect(headers['anthropic-ratelimit-unified-status']).toBe('rejected');
		expect(headers['x-should-retry']).toBe('true');
	});

	it('Claude, unknown reset: rejected without a reset or retry verdict', () => {
		expect(AccountFallback.limitHeaders('claude', {}, null, NOW)).toEqual({ 'anthropic-ratelimit-unified-status': 'rejected' });
	});

	it('ChatGPT: only retry-after, no Anthropic headers', () => {
		expect(AccountFallback.limitHeaders('openai', {}, NOW + 120_000, NOW)).toEqual({ 'retry-after': '120' });
	});
});
