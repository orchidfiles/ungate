import { describe, expect, it } from 'vitest';

import { errorKey, poolBalance } from 'src/database/insights';

describe('poolBalance', () => {
	it('is 1 for an evenly used pool', () => {
		expect(poolBalance([100, 100, 100])).toBeCloseTo(1);
	});

	it('is 0 when one account does all the work', () => {
		expect(poolBalance([1000, 0, 0])).toBeCloseTo(0);
		expect(poolBalance([1000, 0])).toBeCloseTo(0);
	});

	it('falls between for uneven pools and drops for more skew', () => {
		const mild = poolBalance([60, 40]);
		const strong = poolBalance([90, 10]);

		expect(mild).toBeGreaterThan(strong ?? 1);
		expect(mild).toBeGreaterThan(0);
		expect(mild).toBeLessThan(1);
	});

	it('is null with fewer than two accounts or no tokens', () => {
		expect(poolBalance([500])).toBeNull();
		expect(poolBalance([])).toBeNull();
		expect(poolBalance([0, 0])).toBeNull();
	});
});

describe('errorKey', () => {
	it('groups errors by their leading phrase and masks numbers', () => {
		expect(errorKey('Upstream 529: overloaded')).toBe('Upstream N');
		expect(errorKey('Upstream 500: internal')).toBe('Upstream N');
		expect(errorKey('Rate limit exceeded (resets in 300s)')).toBe('Rate limit exceeded');
		expect(errorKey(': odd')).toBe('error');
	});
});
