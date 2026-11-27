import { describe, expect, it } from 'vitest';

import { ESTIMATED_COOLDOWN_MS, UsageLimitClassifier, parseRetryAfter } from 'src/proxy/usage-limit-classifier';

const NOW = 1_800_000_000_000;
const SEC = Math.floor(NOW / 1000);

const input = (status: number, headers: Record<string, string> = {}, body?: unknown) => ({
	status,
	headers: new Headers(headers),
	body
});

/**
 * Fixtures mirror the shapes parsed by openai/codex `codex-rs/codex-api` (429 body
 * `{ error: { type, plan_type, resets_at | resets_in_seconds } }`, `x-codex-*` headers) and by
 * Claude Code 2.1.9 `cli.js` (`anthropic-ratelimit-unified-*` headers). Values are sanitized.
 */
const codexUsageLimit = (error: Record<string, unknown>) => ({
	error: { message: 'The usage limit has been reached', plan_type: 'plus', ...error }
});

describe('UsageLimitClassifier — ChatGPT Codex', () => {
	const classify = (status: number, headers: Record<string, string> = {}, body?: unknown) =>
		UsageLimitClassifier.classify('openai', input(status, headers, body), NOW);

	it('recognizes usage_limit_reached with resets_at (unix seconds)', () => {
		const result = classify(429, {}, codexUsageLimit({ type: 'usage_limit_reached', resets_at: SEC + 3600 }));
		expect(result).toEqual({
			kind: 'usage_limit',
			resetAt: NOW + 3_600_000,
			estimated: false,
			reason: 'codex_usage_limit_reached'
		});
	});

	it('accepts the marker in error.code and the older resets_in_seconds', () => {
		const result = classify(429, {}, codexUsageLimit({ code: 'usage_limit_reached', resets_in_seconds: 120 }));
		expect(result.kind).toBe('usage_limit');
		expect(result.resetAt).toBe(NOW + 120_000);
		expect(result.estimated).toBe(false);
	});

	it('falls back to x-codex window reset, then retry-after', () => {
		const viaWindow = classify(
			429,
			{ 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': String(SEC + 600) },
			codexUsageLimit({ type: 'usage_limit_reached' })
		);
		expect(viaWindow.resetAt).toBe(NOW + 600_000);

		const viaRetryAfter = classify(429, { 'retry-after': '90' }, codexUsageLimit({ type: 'usage_limit_reached' }));
		expect(viaRetryAfter).toMatchObject({ kind: 'usage_limit', resetAt: NOW + 90_000, estimated: false });
	});

	it('uses a 60s estimated cooldown when a recognized limit has no reset', () => {
		const result = classify(429, {}, codexUsageLimit({ type: 'usage_limit_reached' }));
		expect(result).toEqual({
			kind: 'usage_limit',
			resetAt: NOW + ESTIMATED_COOLDOWN_MS,
			estimated: true,
			reason: 'codex_usage_limit_reached'
		});
	});

	it('ignores past or absurd reset values and estimates instead', () => {
		expect(classify(429, {}, codexUsageLimit({ type: 'usage_limit_reached', resets_at: SEC - 10 })).estimated).toBe(true);
		expect(classify(429, {}, codexUsageLimit({ type: 'usage_limit_reached', resets_at: SEC + 400 * 86400 })).estimated).toBe(
			true
		);
	});

	it('treats an exhausted x-codex window as account-exhausted even without the body marker', () => {
		const result = classify(
			429,
			{
				'x-codex-primary-used-percent': '100',
				'x-codex-primary-reset-after-seconds': '30',
				'x-codex-secondary-used-percent': '100',
				'x-codex-secondary-reset-at': String(SEC + 7200)
			},
			{ error: { type: 'rate_limit_exceeded', message: 'Rate limit reached' } }
		);
		expect(result).toMatchObject({ kind: 'usage_limit', resetAt: NOW + 7_200_000, reason: 'codex_rate_limit_window_exhausted' });
	});

	it('does not rotate on plain rate_limit_exceeded, insufficient_quota, usage_not_included, or non-429', () => {
		expect(classify(429, { 'retry-after': '5' }, { error: { type: 'rate_limit_exceeded' } }).kind).toBe('other');
		expect(classify(429, {}, { error: { type: 'insufficient_quota', code: 'insufficient_quota' } })).toMatchObject({
			kind: 'other',
			reason: 'codex_insufficient_quota'
		});
		expect(classify(429, {}, { error: { type: 'usage_not_included' } }).kind).toBe('other');
		expect(classify(429, { 'x-codex-primary-used-percent': '42' }, undefined).kind).toBe('other');
		expect(classify(500, {}, codexUsageLimit({ type: 'usage_limit_reached' })).kind).toBe('other');
		expect(classify(403, {}, { detail: 'forbidden' }).kind).toBe('other');
	});
});

describe('UsageLimitClassifier — Anthropic Claude Code OAuth', () => {
	const classify = (status: number, headers: Record<string, string> = {}, body?: unknown) =>
		UsageLimitClassifier.classify('claude', input(status, headers, body), NOW);
	const rateLimitBody = { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } };

	it('recognizes unified-status rejected with unified-reset (unix seconds)', () => {
		const result = classify(
			429,
			{
				'anthropic-ratelimit-unified-status': 'rejected',
				'anthropic-ratelimit-unified-reset': String(SEC + 5 * 3600),
				'retry-after': '18000',
				'x-should-retry': 'false'
			},
			rateLimitBody
		);
		expect(result).toEqual({
			kind: 'usage_limit',
			resetAt: NOW + 5 * 3_600_000,
			estimated: false,
			reason: 'anthropic_usage_limit'
		});
	});

	it('recognizes per-window rejected status and uses that window reset', () => {
		const result = classify(
			429,
			{
				'anthropic-ratelimit-unified-5h-status': 'allowed',
				'anthropic-ratelimit-unified-7d-status': 'rejected',
				'anthropic-ratelimit-unified-7d-reset': String(SEC + 86400)
			},
			rateLimitBody
		);
		expect(result).toMatchObject({ kind: 'usage_limit', resetAt: NOW + 86_400_000, reason: 'anthropic_usage_limit_7d' });
	});

	it('falls back to retry-after, then a 60s estimate', () => {
		expect(classify(429, { 'anthropic-ratelimit-unified-status': 'rejected', 'retry-after': '45' }).resetAt).toBe(NOW + 45_000);
		expect(classify(429, { 'anthropic-ratelimit-unified-status': 'rejected' })).toMatchObject({
			resetAt: NOW + ESTIMATED_COOLDOWN_MS,
			estimated: true
		});
	});

	it('treats a 429 without unified rejection as ordinary throttling', () => {
		expect(classify(429, { 'retry-after': '10', 'x-should-retry': 'true' }, rateLimitBody)).toMatchObject({
			kind: 'other',
			reason: 'anthropic_rate_limited'
		});
		expect(classify(429, { 'anthropic-ratelimit-unified-status': 'allowed_warning' }).kind).toBe('other');
	});

	it('never rotates on non-429 statuses', () => {
		const headers = { 'anthropic-ratelimit-unified-status': 'rejected' };
		for (const status of [400, 401, 403, 500, 503, 529]) expect(classify(status, headers).kind).toBe('other');
	});
});

describe('parseRetryAfter', () => {
	it('parses delta seconds, ms and HTTP dates', () => {
		expect(parseRetryAfter(new Headers({ 'retry-after': '3' }), NOW)).toBe(NOW + 3000);
		expect(parseRetryAfter(new Headers({ 'retry-after-ms': '1500' }), NOW)).toBe(NOW + 1500);
		const date = new Date(NOW + 60_000).toUTCString();
		expect(parseRetryAfter(new Headers({ 'retry-after': date }), NOW)).toBe(Math.floor((NOW + 60_000) / 1000) * 1000);
		expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }), NOW)).toBeUndefined();
	});
});
