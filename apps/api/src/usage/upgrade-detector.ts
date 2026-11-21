import type { UsageWindow } from '@ungate/shared';

export type CooldownLiftReason = 'plan_upgraded' | 'usage_available';

export interface UpgradeCheckInput {
	/** Last tier persisted on the account row (`oauth_accounts.planType`). */
	previousPlan: string | null;
	/** Tier reported by the fresh endpoint fetch. */
	newPlan: string | null;
	/** Windows from a successful usage-endpoint fetch. Header-only data must not be passed here. */
	windows: UsageWindow[];
	cooldownReason: string | null;
	cooldownUntil: number | null;
	now: number;
}

/**
 * Tier ranks. ChatGPT: free < go < plus < pro < team/business < enterprise/edu.
 * Claude: free < pro < max (5x) < max 20x < team < enterprise. Gemini: free < legacy < standard.
 * All scales share one table because plan strings never overlap between providers (Claude tiers
 * are `claude_`-prefixed, Gemini tiers `-tier`-suffixed).
 */
const PLAN_RANKS: Record<string, number> = {
	free: 0,
	go: 1,
	plus: 2,
	pro: 3,
	team: 4,
	business: 4,
	enterprise: 5,
	edu: 5,
	claude_free: 0,
	claude_pro: 1,
	claude_max: 2,
	claude_max_5x: 2,
	claude_max_20x: 3,
	claude_team: 4,
	claude_enterprise: 5,
	// Gemini Code Assist tier ids (`loadCodeAssist` `currentTier.id`).
	'free-tier': 0,
	'legacy-tier': 1,
	'standard-tier': 2
};

export function planRank(plan: string | null): number | null {
	if (!plan) return null;

	return PLAN_RANKS[plan.trim().toLowerCase()] ?? null;
}

/** Cooldowns caused by subscription usage limits (not throttling, not stream errors). */
export function isUsageLimitCooldown(reason: string | null): boolean {
	if (!reason) return false;

	return (
		reason.startsWith('anthropic_usage_limit') ||
		reason === 'codex_usage_limit_reached' ||
		reason === 'codex_rate_limit_window_exhausted' ||
		reason === 'gemini_quota_exhausted'
	);
}

/**
 * Decides whether a fresh usage fetch proves a cooling-down account usable again. Only ever lifts a
 * cooldown; never creates or extends one. Returns null when the account is not cooling down.
 */
export function shouldLiftCooldown(input: UpgradeCheckInput): CooldownLiftReason | null {
	if (input.cooldownUntil === null || input.cooldownUntil <= input.now) return null;

	if (planUpgraded(input.previousPlan, input.newPlan)) return 'plan_upgraded';

	if (
		isUsageLimitCooldown(input.cooldownReason) &&
		input.windows.length > 0 &&
		input.windows.every((window) => window.usedPercent < 100)
	) {
		return 'usage_available';
	}

	return null;
}

function planUpgraded(previousPlan: string | null, newPlan: string | null): boolean {
	if (!previousPlan || !newPlan) return false;
	const previous = previousPlan.trim().toLowerCase();
	const next = newPlan.trim().toLowerCase();
	if (previous === next) return false;
	const previousRank = planRank(previous);
	const nextRank = planRank(next);
	if (previousRank === null) return false;
	// An unknown new tier differing from a known previous one is treated as a change.
	if (nextRank === null) return true;

	return nextRank > previousRank;
}
