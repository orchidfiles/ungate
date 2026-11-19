import { describe, expect, it } from 'vitest';

import {
	labelForMinutes,
	parseClaudeUsageBody,
	parseClaudeUsageHeaders,
	parseCodexPlanHeader,
	parseCodexUsageBody,
	parseCodexUsageHeaders
} from 'src/usage/usage-parsers';

const NOW = 1_800_000_000_000;
const SEC = Math.floor(NOW / 1000);

describe('labelForMinutes', () => {
	it('names common windows', () => {
		expect(labelForMinutes(300)).toBe('5-hour');
		expect(labelForMinutes(10080)).toBe('Weekly');
		expect(labelForMinutes(1440)).toBe('Daily');
		expect(labelForMinutes(2880)).toBe('2-day');
		expect(labelForMinutes(90)).toBe('90-minute');
		expect(labelForMinutes(0)).toBeUndefined();
		expect(labelForMinutes(null)).toBeUndefined();
	});
});

describe('Claude usage', () => {
	it('parses the /api/oauth/usage body (percent scale, ISO resets, null windows skipped)', () => {
		const { windows, cleared } = parseClaudeUsageBody({
			five_hour: { utilization: 42.5, resets_at: '2027-01-15T12:00:00Z' },
			seven_day: { utilization: 120, resets_at: null },
			seven_day_opus: { utilization: 7, resets_at: '2027-01-20T00:00:00Z' },
			seven_day_sonnet: null,
			seven_day_oauth_apps: { utilization: null, resets_at: null },
			extra_usage: { is_enabled: false }
		});
		expect(cleared).toEqual(['7d_sonnet', '7d_oauth_apps']);
		expect(windows).toEqual([
			{ id: '5h', label: '5-hour', usedPercent: 42.5, resetsAt: Date.parse('2027-01-15T12:00:00Z'), windowMinutes: 300 },
			{ id: '7d', label: 'Weekly', usedPercent: 100, resetsAt: null, windowMinutes: 10080 },
			{
				id: '7d_opus',
				label: 'Weekly (Opus)',
				usedPercent: 7,
				resetsAt: Date.parse('2027-01-20T00:00:00Z'),
				windowMinutes: 10080
			}
		]);
	});

	it('ignores non-object bodies', () => {
		expect(parseClaudeUsageBody(null)).toEqual({ windows: [], cleared: [] });
		expect(parseClaudeUsageBody([1])).toEqual({ windows: [], cleared: [] });
	});

	it('parses unified rate-limit headers (fraction scale, unix-second resets)', () => {
		const windows = parseClaudeUsageHeaders(
			new Headers({
				'anthropic-ratelimit-unified-5h-utilization': '0.25',
				'anthropic-ratelimit-unified-5h-reset': String(SEC + 3600),
				'anthropic-ratelimit-unified-7d-utilization': '0.9',
				'anthropic-ratelimit-unified-status': 'allowed'
			})
		);
		expect(windows).toEqual(
			expect.arrayContaining([
				{ id: '5h', label: '5-hour', usedPercent: 25, resetsAt: (SEC + 3600) * 1000, windowMinutes: 300 },
				{ id: '7d', label: 'Weekly', usedPercent: 90, resetsAt: null, windowMinutes: 10080 }
			])
		);
		expect(windows).toHaveLength(2);
	});
});

describe('ChatGPT usage', () => {
	it('parses the /wham/usage body with reset_at and reset_after_seconds', () => {
		const result = parseCodexUsageBody(
			{
				plan_type: 'plus',
				rate_limit: {
					primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: SEC + 600 },
					secondary_window: { used_percent: 55.5, limit_window_seconds: 604800, reset_after_seconds: 7200 }
				}
			},
			NOW
		);
		expect(result).toEqual({
			planType: 'plus',
			cleared: [],
			windows: [
				{ id: 'primary', label: '5-hour', usedPercent: 12, resetsAt: (SEC + 600) * 1000, windowMinutes: 300 },
				{ id: 'secondary', label: 'Weekly', usedPercent: 55.5, resetsAt: NOW + 7_200_000, windowMinutes: 10080 }
			]
		});
	});

	it('handles missing rate limits', () => {
		expect(parseCodexUsageBody({ plan_type: 'free', rate_limit: null })).toEqual({
			planType: 'free',
			windows: [],
			cleared: ['primary', 'secondary']
		});
		expect(parseCodexUsageBody({ rate_limit: { primary_window: { used_percent: 3 }, secondary_window: null } })).toEqual({
			planType: null,
			windows: [expect.objectContaining({ id: 'primary', usedPercent: 3 })],
			cleared: ['secondary']
		});
		expect(parseCodexUsageBody({ plan_type: 'plus' })).toEqual({ planType: 'plus', windows: [], cleared: [] });
		expect(parseCodexUsageBody('nope')).toEqual({ planType: null, windows: [], cleared: [] });
	});

	it('parses x-codex-* headers', () => {
		const headers = new Headers({
			'x-codex-primary-used-percent': '101',
			'x-codex-primary-window-minutes': '300',
			'x-codex-primary-reset-after-seconds': '60',
			'x-codex-secondary-used-percent': '3',
			'x-codex-plan-type': 'pro'
		});
		expect(parseCodexUsageHeaders(headers, NOW)).toEqual([
			{ id: 'primary', label: '5-hour', usedPercent: 100, resetsAt: NOW + 60_000, windowMinutes: 300 },
			{ id: 'secondary', label: 'Long window', usedPercent: 3, resetsAt: null, windowMinutes: null }
		]);
		expect(parseCodexPlanHeader(headers)).toBe('pro');
		expect(parseCodexUsageHeaders(new Headers(), NOW)).toEqual([]);
	});
});
