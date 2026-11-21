import { parseClaudeUsageHeaders, parseCodexPlanHeader, parseCodexUsageHeaders, type UsageEndpointResult } from './usage-parsers';

import type { AccountUsage, SubscriptionProvider, UsageWindow } from '@ungate/shared';

/** Stable display order: short windows first, then weekly, then model-specific variants. */
function sortWindows(windows: UsageWindow[]): UsageWindow[] {
	return [...windows].sort(
		(a, b) =>
			(a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity) || a.id.length - b.id.length || a.id.localeCompare(b.id)
	);
}

function merge(existing: UsageWindow[], updates: UsageWindow[]): UsageWindow[] {
	const byId = new Map(existing.map((window) => [window.id, window]));
	for (const update of updates) byId.set(update.id, update);

	return sortWindows([...byId.values()]);
}

/**
 * In-memory per-account usage cache (not persisted; refilled by the next fetch or proxied response).
 * Updates merge by window id, so header updates (which only cover the windows the response
 * reported) never drop windows only the usage endpoint reports, such as `7d_opus`.
 */
export class AccountUsageStore {
	private static entries = new Map<string, AccountUsage>();

	static get(accountId: string): AccountUsage | undefined {
		return this.entries.get(accountId);
	}

	/** Records rate-limit headers from a proxied response; ignored when the response carries none. */
	static recordHeaders(provider: SubscriptionProvider, accountId: string, headers: Headers, now = Date.now()): void {
		// Code Assist reports quota only through `retrieveUserQuota`, never on responses.
		if (provider === 'gemini') return;
		const windows = provider === 'claude' ? parseClaudeUsageHeaders(headers) : parseCodexUsageHeaders(headers, now);
		if (!windows.length) return;
		const existing = this.entries.get(accountId);
		const planType = provider === 'openai' ? parseCodexPlanHeader(headers) : null;
		this.entries.set(accountId, {
			windows: merge(existing?.windows ?? [], windows),
			planType: planType ?? existing?.planType ?? null,
			source: 'headers',
			updatedAt: now,
			error: existing?.error ?? null
		});
	}

	/**
	 * Records a successful usage-endpoint fetch and clears any previous fetch error. Windows the
	 * endpoint reports as null are dropped so a limit the account no longer has stops showing.
	 */
	static recordEndpoint(accountId: string, result: UsageEndpointResult, now = Date.now()): void {
		const existing = this.entries.get(accountId);
		const kept = (existing?.windows ?? []).filter((window) => !result.cleared.includes(window.id));
		this.entries.set(accountId, {
			windows: merge(kept, result.windows),
			planType: result.planType ?? existing?.planType ?? null,
			source: 'endpoint',
			updatedAt: now,
			error: null
		});
	}

	/** Records a failed usage fetch, keeping previously known windows. */
	static recordError(accountId: string, error: string, now = Date.now()): void {
		const existing = this.entries.get(accountId);
		this.entries.set(accountId, {
			windows: existing?.windows ?? [],
			planType: existing?.planType ?? null,
			source: existing?.source ?? 'endpoint',
			updatedAt: existing?.updatedAt ?? now,
			error
		});
	}

	static delete(accountId: string): void {
		this.entries.delete(accountId);
	}

	/** Test helper. */
	static clear(): void {
		this.entries.clear();
	}
}
