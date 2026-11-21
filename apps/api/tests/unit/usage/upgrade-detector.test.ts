import { describe, expect, it } from 'vitest';

import { shouldLiftCooldown, type UpgradeCheckInput } from 'src/usage/upgrade-detector';
import { parseClaudeProfilePlan } from 'src/usage/usage-parsers';

import type { UsageWindow } from '@ungate/shared';

const NOW = 1_800_000_000_000;
const win = (usedPercent: number, id = '5h'): UsageWindow => ({ id, label: id, usedPercent, resetsAt: null, windowMinutes: 300 });
const input = (overrides: Partial<UpgradeCheckInput>): UpgradeCheckInput => ({
	previousPlan: 'plus',
	newPlan: 'plus',
	windows: [win(100)],
	cooldownReason: 'codex_usage_limit_reached',
	cooldownUntil: NOW + 60_000,
	now: NOW,
	...overrides
});

describe('shouldLiftCooldown', () => {
	it('lifts on a plan upgrade', () => {
		expect(shouldLiftCooldown(input({ previousPlan: 'plus', newPlan: 'pro' }))).toBe('plan_upgraded');
		expect(shouldLiftCooldown(input({ previousPlan: 'claude_pro', newPlan: 'claude_max_20x' }))).toBe('plan_upgraded');
		expect(shouldLiftCooldown(input({ previousPlan: 'claude_max_5x', newPlan: 'claude_max_20x' }))).toBe('plan_upgraded');
	});

	it('does not lift on a downgrade or unchanged plan', () => {
		expect(shouldLiftCooldown(input({ previousPlan: 'pro', newPlan: 'plus' }))).toBeNull();
		expect(shouldLiftCooldown(input({ previousPlan: 'pro', newPlan: 'PRO' }))).toBeNull();
	});

	it('treats an unknown new tier as a change only after a known one', () => {
		expect(shouldLiftCooldown(input({ previousPlan: 'plus', newPlan: 'mystery_tier' }))).toBe('plan_upgraded');
		expect(shouldLiftCooldown(input({ previousPlan: 'mystery_tier', newPlan: 'other_tier' }))).toBeNull();
		expect(shouldLiftCooldown(input({ previousPlan: null, newPlan: 'pro' }))).toBeNull();
	});

	it('lifts a usage-limit cooldown only when every window is under 100%', () => {
		expect(shouldLiftCooldown(input({ windows: [win(40), win(99, '7d')] }))).toBe('usage_available');
		expect(shouldLiftCooldown(input({ windows: [win(40), win(100, '7d')] }))).toBeNull();
		expect(shouldLiftCooldown(input({ cooldownReason: 'anthropic_usage_limit_7d', windows: [win(10)] }))).toBe('usage_available');
	});

	it('needs endpoint windows (header-only data is never passed in)', () => {
		expect(shouldLiftCooldown(input({ windows: [] }))).toBeNull();
	});

	it('ignores non-usage cooldown reasons for the usage path', () => {
		expect(shouldLiftCooldown(input({ cooldownReason: 'anthropic_rate_limited', windows: [win(10)] }))).toBeNull();
		expect(shouldLiftCooldown(input({ cooldownReason: 'codex_stream_error', windows: [win(10)] }))).toBeNull();
	});

	it('does nothing when the account is not cooling down', () => {
		expect(shouldLiftCooldown(input({ cooldownUntil: null, newPlan: 'pro' }))).toBeNull();
		expect(shouldLiftCooldown(input({ cooldownUntil: NOW - 1, newPlan: 'pro' }))).toBeNull();
	});
});

describe('parseClaudeProfilePlan', () => {
	it('maps rate-limit tiers and org types', () => {
		expect(
			parseClaudeProfilePlan({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } })
		).toBe('claude_max_20x');
		expect(parseClaudeProfilePlan({ organization: { rate_limit_tier: 'default_claude_max_5x' } })).toBe('claude_max_5x');
		expect(parseClaudeProfilePlan({ account: { has_claude_max: true }, organization: {} })).toBe('claude_max_5x');
		expect(parseClaudeProfilePlan({ account: { has_claude_pro: true }, organization: {} })).toBe('claude_pro');
		expect(parseClaudeProfilePlan({ organization: { organization_type: 'claude_team' } })).toBe('claude_team');
		expect(parseClaudeProfilePlan({ organization: {} })).toBeNull();
		expect(parseClaudeProfilePlan('nope')).toBeNull();
	});
});
