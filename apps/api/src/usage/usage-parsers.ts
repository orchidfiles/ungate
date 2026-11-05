import { parseResetTimestamp } from '../proxy/usage-limit-classifier';

import type { UsageWindow } from '@ungate/shared';

/**
 * Pure parsers for subscription usage reported by the providers.
 *
 * - Claude `GET /api/oauth/usage` (what Claude Code's `/usage` shows): `{ five_hour, seven_day,
 *   seven_day_opus, seven_day_sonnet, … }`, each `{ utilization: 0–100, resets_at: ISO }` or null.
 * - Claude response headers: `anthropic-ratelimit-unified-<window>-utilization` (0–1 fraction) and
 *   `anthropic-ratelimit-unified-<window>-reset` (unix seconds), windows `5h`, `7d`, `7d_opus`, ….
 * - ChatGPT `GET /backend-api/wham/usage` (what Codex `/status` shows): `{ plan_type, rate_limit:
 *   { primary_window, secondary_window } }`, each `{ used_percent, limit_window_seconds,
 *   reset_at | reset_after_seconds }`.
 * - ChatGPT response headers: `x-codex-{primary,secondary}-used-percent`, `-window-minutes`,
 *   `-reset-at` (unix seconds) or `-reset-after-seconds`.
 */

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);

	return undefined;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function header(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);

	return value === null || value.trim() === '' ? undefined : value.trim();
}

function titleCase(value: string): string {
	return value
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(' ');
}

/** "5-hour", "Weekly", "Daily", otherwise "N-hour" / "N-day" / "N-minute". */
export function labelForMinutes(minutes: number | null | undefined): string | undefined {
	if (!minutes || minutes <= 0) return undefined;
	if (minutes === MINUTES_PER_WEEK) return 'Weekly';
	if (minutes === MINUTES_PER_DAY) return 'Daily';
	if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}-day`;
	if (minutes % 60 === 0) return `${minutes / 60}-hour`;

	return `${minutes}-minute`;
}

/** `5h` / `7d` / `7d_opus` → minutes and label ("5-hour", "Weekly (Opus)"). */
function describeClaudeWindow(id: string): { label: string; windowMinutes: number | null } {
	const match = /^(\d+)([hd])(?:_(.+))?$/.exec(id);
	if (!match) return { label: titleCase(id), windowMinutes: null };
	const amount = Number(match[1]);
	const minutes = match[2] === 'h' ? amount * 60 : amount * MINUTES_PER_DAY;
	const base = labelForMinutes(minutes) ?? id;

	return { label: match[3] ? `${base} (${titleCase(match[3])})` : base, windowMinutes: minutes };
}

const CLAUDE_BODY_PREFIXES: Record<string, string> = { five_hour: '5h', seven_day: '7d' };

/** Claude `/api/oauth/usage` body → windows (null / malformed windows are skipped). */
export function parseClaudeUsageBody(body: unknown): UsageWindow[] {
	const root = record(body);
	if (!root) return [];
	const windows: UsageWindow[] = [];

	for (const [key, value] of Object.entries(root)) {
		const match = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key);
		const window = record(value);
		if (!match || !window) continue;
		const utilization = finiteNumber(window.utilization);
		if (utilization === undefined) continue;
		const id = match[2] ? `${CLAUDE_BODY_PREFIXES[match[1]]}_${match[2]}` : CLAUDE_BODY_PREFIXES[match[1]];
		const { label, windowMinutes } = describeClaudeWindow(id);
		windows.push({
			id,
			label,
			usedPercent: clampPercent(utilization),
			resetsAt: parseResetTimestamp(window.resets_at) ?? null,
			windowMinutes
		});
	}

	return windows;
}

const CLAUDE_UTILIZATION_HEADER = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/;

/** Claude `anthropic-ratelimit-unified-<window>-utilization` headers (0–1 fraction) → windows. */
export function parseClaudeUsageHeaders(headers: Headers): UsageWindow[] {
	const windows: UsageWindow[] = [];

	for (const [name, value] of headers.entries()) {
		const id = CLAUDE_UTILIZATION_HEADER.exec(name.toLowerCase())?.[1];
		const fraction = finiteNumber(value);
		if (!id || fraction === undefined) continue;
		const { label, windowMinutes } = describeClaudeWindow(id);
		windows.push({
			id,
			label,
			usedPercent: clampPercent(fraction * 100),
			resetsAt: parseResetTimestamp(header(headers, `anthropic-ratelimit-unified-${id}-reset`)) ?? null,
			windowMinutes
		});
	}

	return windows;
}

function codexWindow(
	id: 'primary' | 'secondary',
	usedPercent: number,
	windowMinutes: number | undefined,
	resetsAt: number | undefined
): UsageWindow {
	const fallback = id === 'primary' ? 'Short window' : 'Long window';

	return {
		id,
		label: labelForMinutes(windowMinutes) ?? fallback,
		usedPercent: clampPercent(usedPercent),
		resetsAt: resetsAt ?? null,
		windowMinutes: windowMinutes ?? null
	};
}

/** ChatGPT `/backend-api/wham/usage` body → plan type and windows. */
export function parseCodexUsageBody(body: unknown, now = Date.now()): { planType: string | null; windows: UsageWindow[] } {
	const root = record(body);
	if (!root) return { planType: null, windows: [] };
	const planType = typeof root.plan_type === 'string' && root.plan_type ? root.plan_type : null;
	const rateLimit = record(root.rate_limit);
	const windows: UsageWindow[] = [];

	for (const id of ['primary', 'secondary'] as const) {
		const window = record(rateLimit?.[`${id}_window`]);
		const used = finiteNumber(window?.used_percent);
		if (!window || used === undefined) continue;
		const seconds = finiteNumber(window.limit_window_seconds);
		const resetAfter = finiteNumber(window.reset_after_seconds);
		const resetsAt = parseResetTimestamp(window.reset_at) ?? (resetAfter !== undefined ? now + resetAfter * 1000 : undefined);
		windows.push(codexWindow(id, used, seconds !== undefined ? Math.round(seconds / 60) : undefined, resetsAt));
	}

	return { planType, windows };
}

/** ChatGPT `x-codex-{primary,secondary}-*` response headers → windows. */
export function parseCodexUsageHeaders(headers: Headers, now = Date.now()): UsageWindow[] {
	const windows: UsageWindow[] = [];

	for (const id of ['primary', 'secondary'] as const) {
		const used = finiteNumber(header(headers, `x-codex-${id}-used-percent`));
		if (used === undefined) continue;
		const minutes = finiteNumber(header(headers, `x-codex-${id}-window-minutes`));
		const resetAfter = finiteNumber(header(headers, `x-codex-${id}-reset-after-seconds`));
		const resetsAt =
			parseResetTimestamp(header(headers, `x-codex-${id}-reset-at`)) ??
			(resetAfter !== undefined ? now + resetAfter * 1000 : undefined);
		windows.push(codexWindow(id, used, minutes, resetsAt));
	}

	return windows;
}

/** Plan type reported on Codex responses (`x-codex-plan-type`), when present. */
export function parseCodexPlanHeader(headers: Headers): string | null {
	return header(headers, 'x-codex-plan-type') ?? null;
}
