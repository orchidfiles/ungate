import { describe, expect, it } from 'vitest';

import { Pricing } from 'src/database/pricing';

describe('database-pricing', () => {
	it('matches pricing by exact id and prefix', () => {
		expect(Pricing.getModel('gpt-5.6-sol')).toEqual({ inputPerMTok: 5.0, outputPerMTok: 30.0 });
		expect(Pricing.getModel('gpt-5.6-terra')).toEqual({ inputPerMTok: 2.5, outputPerMTok: 15.0 });
		expect(Pricing.getModel('gpt-5.6-luna')).toEqual({ inputPerMTok: 1.0, outputPerMTok: 6.0 });
		expect(Pricing.getModel('claude-sonnet-4-6')).toEqual({ inputPerMTok: 3.0, outputPerMTok: 15.0 });
		expect(Pricing.getModel('claude-sonnet-4-6-20250514')).toEqual({ inputPerMTok: 3.0, outputPerMTok: 15.0 });
		expect(Pricing.getModel('unknown-model')).toEqual({ inputPerMTok: 3.0, outputPerMTok: 15.0 });
	});

	it('calculates regular and cache token costs', () => {
		const cost = Pricing.calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000, 100_000, 200_000);
		expect(cost).toBeCloseTo(17.88, 6);
	});
});
