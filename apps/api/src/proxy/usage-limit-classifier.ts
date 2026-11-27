import type { SubscriptionProvider } from '@ungate/shared';

/**
 * Provider-specific classification of upstream HTTP errors into "this subscription account hit
 * its usage limit" (rotate / cool down) versus everything else (surface the error, no rotation).
 *
 * Unknown signals are always `other`: an ordinary 429 (request throttling), 5xx, permission or
 * network error must never cool down an account or trigger account switching.
 */
export interface UsageLimitClassification {
	kind: 'usage_limit' | 'other';
	/** Unix ms when the account becomes usable again. Always set for `usage_limit`. */
	resetAt?: number;
	/** True when `resetAt` is a bounded fallback rather than an upstream-provided reset. */
	estimated: boolean;
	/** Token-free machine reason, stored as the cooldown reason. */
	reason: string;
}

export interface UpstreamErrorInput {
	status: number;
	headers: Headers;
	/** Parsed JSON body, or undefined when the body was empty / not JSON. */
	body: unknown;
}

/** Recognized limit with no trustworthy reset: bounded, clearly-estimated cooldown. */
export const ESTIMATED_COOLDOWN_MS = 60_000;
/** Resets further out than this are treated as untrustworthy (longest known window is 7 days). */
const MAX_RESET_HORIZON_MS = 31 * 24 * 60 * 60_000;

interface ResetSource {
	at: number;
	source: string;
}

function header(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);

	return value === null || value.trim() === '' ? undefined : value.trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);

	return undefined;
}

/** Unix seconds (or ms when already ms-sized) or an HTTP/ISO date → unix ms. */
export function parseResetTimestamp(value: unknown): number | undefined {
	const numeric = finiteNumber(value);
	if (numeric !== undefined) return numeric > 1e12 ? numeric : numeric * 1000;
	if (typeof value !== 'string') return undefined;
	const parsed = Date.parse(value);

	return Number.isNaN(parsed) ? undefined : parsed;
}

/** `retry-after` (delta seconds or HTTP date) / `retry-after-ms` → unix ms. */
export function parseRetryAfter(headers: Headers, now: number): number | undefined {
	const ms = finiteNumber(header(headers, 'retry-after-ms'));
	if (ms !== undefined && ms >= 0) return now + ms;
	const raw = header(headers, 'retry-after');
	if (raw === undefined) return undefined;
	const seconds = finiteNumber(raw);
	if (seconds !== undefined) return seconds >= 0 ? now + seconds * 1000 : undefined;
	const date = Date.parse(raw);

	return Number.isNaN(date) ? undefined : date;
}

function trustworthy(candidate: ResetSource | undefined, now: number): candidate is ResetSource {
	return !!candidate && candidate.at > now && candidate.at - now <= MAX_RESET_HORIZON_MS;
}

function limited(reason: string, now: number, ...candidates: (ResetSource | undefined)[]): UsageLimitClassification {
	const reset = candidates.find((candidate) => trustworthy(candidate, now));
	if (reset) return { kind: 'usage_limit', resetAt: reset.at, estimated: false, reason };

	return { kind: 'usage_limit', resetAt: now + ESTIMATED_COOLDOWN_MS, estimated: true, reason };
}

function other(reason: string): UsageLimitClassification {
	return { kind: 'other', estimated: false, reason };
}

/**
 * ChatGPT Codex (`chatgpt.com/backend-api/codex/responses`).
 *
 * Source: openai/codex `codex-rs/codex-api` (+ `codex-rs/core` error mapping). On HTTP 429 the
 * body is parsed as `{ error: { type, plan_type, resets_at, resets_in_seconds } }`:
 * - `error.type == "usage_limit_reached"` → `UsageLimitReached` (plan quota exhausted), reset from
 *   `error.resets_at` (unix seconds) or older builds' `error.resets_in_seconds`;
 * - `usage_not_included` and anything else → generic retryable/plan errors, NOT an exhausted quota.
 * Rate-limit snapshots come from `x-codex-{primary,secondary}-used-percent` with
 * `x-codex-{primary,secondary}-reset-at` (unix seconds) or `-reset-after-seconds` (older builds).
 * `insufficient_quota` / plain `rate_limit_exceeded` without those markers stay non-rotating,
 * unless a rate-limit window reports itself as fully used (≥ 100%).
 */
function classifyCodex(input: UpstreamErrorInput, now: number): UsageLimitClassification {
	if (input.status !== 429) return other('codex_not_429');
	const error = record(record(input.body)?.error);
	const marker = [error?.type, error?.code].find((value) => value === 'usage_limit_reached');

	const windows = (['primary', 'secondary'] as const).map((name) => {
		const used = finiteNumber(header(input.headers, `x-codex-${name}-used-percent`));
		const resetAt = parseResetTimestamp(header(input.headers, `x-codex-${name}-reset-at`));
		const resetAfter = finiteNumber(header(input.headers, `x-codex-${name}-reset-after-seconds`));
		const at = resetAt ?? (resetAfter !== undefined ? now + resetAfter * 1000 : undefined);

		return { name, exhausted: used !== undefined && used >= 100, at };
	});
	const exhausted = windows.filter((window) => window.exhausted && window.at !== undefined);
	// The account is blocked until every exhausted window has reset.
	const windowReset: ResetSource | undefined = exhausted.length
		? { at: Math.max(...exhausted.map((window) => window.at!)), source: 'x-codex-window' }
		: undefined;
	const retryAfter = parseRetryAfter(input.headers, now);
	const retryReset: ResetSource | undefined = retryAfter !== undefined ? { at: retryAfter, source: 'retry-after' } : undefined;

	if (marker) {
		const resetsAt = parseResetTimestamp(error?.resets_at);
		const resetsIn = finiteNumber(error?.resets_in_seconds);

		return limited(
			'codex_usage_limit_reached',
			now,
			resetsAt !== undefined ? { at: resetsAt, source: 'resets_at' } : undefined,
			resetsIn !== undefined ? { at: now + resetsIn * 1000, source: 'resets_in_seconds' } : undefined,
			windowReset,
			retryReset
		);
	}

	if (windows.some((window) => window.exhausted)) {
		return limited('codex_rate_limit_window_exhausted', now, windowReset, retryReset);
	}

	return other(error?.type === 'insufficient_quota' ? 'codex_insufficient_quota' : 'codex_rate_limited');
}

/**
 * Anthropic Messages API via Claude Code OAuth.
 *
 * Source: Claude Code 2.1.9 `cli.js` rate-limit handling. Subscription ("unified") limits are
 * reported on HTTP 429 with `anthropic-ratelimit-unified-status: rejected` and the reset in
 * `anthropic-ratelimit-unified-reset` (unix seconds); per-window variants
 * `anthropic-ratelimit-unified-{5h,7d,...}-status|reset` describe the individual windows.
 * `retry-after` and `x-should-retry` accompany them. A 429 without the unified rejection marker is
 * ordinary request throttling and must not rotate accounts.
 */
function classifyAnthropic(input: UpstreamErrorInput, now: number): UsageLimitClassification {
	if (input.status !== 429) return other('anthropic_not_429');
	const prefix = 'anthropic-ratelimit-unified-';
	const rejectedWindows: string[] = [];

	const windowStatus = /^anthropic-ratelimit-unified-([a-z0-9_]+)-status$/;
	for (const [name, value] of input.headers.entries()) {
		const match = windowStatus.exec(name.toLowerCase());
		if (match && value.trim().toLowerCase() === 'rejected') rejectedWindows.push(match[1]);
	}
	const unifiedRejected = header(input.headers, `${prefix}status`)?.toLowerCase() === 'rejected';

	if (!unifiedRejected && rejectedWindows.length === 0) return other('anthropic_rate_limited');

	const unifiedReset = parseResetTimestamp(header(input.headers, `${prefix}reset`));
	const windowResets = rejectedWindows
		.map((window) => parseResetTimestamp(header(input.headers, `${prefix}${window}-reset`)))
		.filter((value): value is number => value !== undefined);
	const retryAfter = parseRetryAfter(input.headers, now);

	return limited(
		rejectedWindows.length ? `anthropic_usage_limit_${rejectedWindows.join('_')}` : 'anthropic_usage_limit',
		now,
		unifiedReset !== undefined ? { at: unifiedReset, source: 'unified-reset' } : undefined,
		windowResets.length ? { at: Math.max(...windowResets), source: 'unified-window-reset' } : undefined,
		retryAfter !== undefined ? { at: retryAfter, source: 'retry-after' } : undefined
	);
}

/** Longest `RetryInfo.retryDelay` still treated as request throttling (gemini-cli's `MAX_RETRYABLE_DELAY_SECONDS`). */
const GEMINI_MAX_THROTTLE_MS = 5 * 60_000;

/** `"34.07s"` / `"900ms"` (google.rpc.RetryInfo duration) → ms. */
function parseGoogleDuration(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const match = /^([0-9.]+)(ms|s)$/.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return undefined;

	return match[2] === 'ms' ? amount : amount * 1000;
}

/** Google API errors arrive as `{ error }` or, on the SSE endpoint, as `[{ error }]`. */
function googleError(body: unknown): Record<string, unknown> | undefined {
	const root = Array.isArray(body) ? body[0] : body;

	return record(record(root)?.error) ?? record(root);
}

function googleDetail(details: unknown, type: string): Record<string, unknown> | undefined {
	if (!Array.isArray(details)) return undefined;

	return details.map(record).find((detail) => typeof detail?.['@type'] === 'string' && detail['@type'].endsWith(type));
}

/**
 * Gemini Code Assist (`cloudcode-pa.googleapis.com/v1internal`).
 *
 * Source: gemini-cli `packages/core/src/utils/googleQuotaErrors.ts`. Errors are google.rpc statuses
 * `{ error: { code, message, status, details: [ErrorInfo, RetryInfo, QuotaFailure] } }`:
 * - 429 `ErrorInfo.reason == QUOTA_EXHAUSTED`, a `PerDay`/`Daily` `QuotaFailure` violation, a
 *   `limit: 0` message, or `RATE_LIMIT_EXCEEDED` with no / a > 5 min `RetryInfo.retryDelay` → the
 *   account's quota is spent (gemini-cli's `TerminalQuotaError`); reset from `retryDelay`.
 * - 403 `ErrorInfo.reason == SUBSCRIPTION_REQUIRED` → this account cannot serve the model: rotate.
 * - Short `RATE_LIMIT_EXCEEDED` / per-minute limits are throttling, and `MODEL_CAPACITY_EXHAUSTED`
 *   is Google-side capacity (another account would hit the same wall): neither rotates.
 */
function classifyGemini(input: UpstreamErrorInput, now: number): UsageLimitClassification {
	const error = googleError(input.body);
	const info = googleDetail(error?.details, 'google.rpc.ErrorInfo');
	const reason = typeof info?.reason === 'string' ? info.reason : undefined;
	const message = typeof error?.message === 'string' ? error.message : '';

	if (input.status === 403) {
		return reason === 'SUBSCRIPTION_REQUIRED' ? limited('gemini_subscription_required', now) : other('gemini_forbidden');
	}
	if (input.status !== 429) return other('gemini_not_429');
	if (reason === 'MODEL_CAPACITY_EXHAUSTED' || reason === 'MODEL_CAPACITY_EXCEEDED') return other('gemini_model_capacity');

	const delay = parseGoogleDuration(googleDetail(error?.details, 'google.rpc.RetryInfo')?.retryDelay);
	const retryAfter = parseRetryAfter(input.headers, now);
	const resets = [
		delay !== undefined ? { at: now + delay, source: 'retry-delay' } : undefined,
		retryAfter !== undefined ? { at: retryAfter, source: 'retry-after' } : undefined
	];
	const violations = googleDetail(error?.details, 'google.rpc.QuotaFailure')?.violations;
	const daily =
		Array.isArray(violations) &&
		violations.some((violation) => {
			const quotaId = record(violation)?.quotaId;

			return typeof quotaId === 'string' && /PerDay|Daily/.test(quotaId);
		});

	if (reason === 'QUOTA_EXHAUSTED' || daily || /limit:\s*0(?!\d|\.\d)/i.test(message)) {
		return limited('gemini_quota_exhausted', now, ...resets);
	}
	if (reason === 'RATE_LIMIT_EXCEEDED' && (delay === undefined || delay > GEMINI_MAX_THROTTLE_MS)) {
		return limited('gemini_quota_exhausted', now, ...resets);
	}

	return other('gemini_rate_limited');
}

/** Codex in-stream error codes that may describe an exhausted plan window (anything else never rotates). */
const CODEX_STREAM_LIMIT_CODES = new Set(['usage_limit_reached', 'rate_limit_exceeded']);

const STREAM_ERROR_PREFIX: Record<SubscriptionProvider, string> = { claude: 'anthropic', openai: 'codex', gemini: 'gemini' };

export class UsageLimitClassifier {
	static classify(provider: SubscriptionProvider, input: UpstreamErrorInput, now = Date.now()): UsageLimitClassification {
		if (provider === 'openai') return classifyCodex(input, now);
		if (provider === 'gemini') return classifyGemini(input, now);

		return classifyAnthropic(input, now);
	}

	/**
	 * Classifies an error delivered inside an HTTP 200 SSE stream, using the same provider rules as
	 * an HTTP 429 with that error body and the stream's response headers:
	 * - Anthropic `event: error` with `error.type == "rate_limit_error"` rotates only when the
	 *   unified rate-limit headers report a rejected window (otherwise it is ordinary throttling);
	 * - Codex `error` / `response.failed` rotates on `usage_limit_reached` (with `resets_at` /
	 *   `resets_in_seconds`), or a rate-limit code while an `x-codex-*` window is fully used.
	 * Any other in-stream error (overloaded, server_error, context length, …) is `other`.
	 */
	static classifyStreamError(
		provider: SubscriptionProvider,
		headers: Headers,
		error: Record<string, unknown> | undefined,
		now = Date.now()
	): UsageLimitClassification {
		if (!error) return other(`${STREAM_ERROR_PREFIX[provider]}_stream_error`);
		if (provider === 'gemini') {
			// A Code Assist stream error is a google.rpc status; only RESOURCE_EXHAUSTED can be a quota.
			if (error.code !== 429 && error.status !== 'RESOURCE_EXHAUSTED') return other('gemini_stream_error');

			return classifyGemini({ status: 429, headers, body: { error } }, now);
		}
		if (provider === 'openai') {
			if (![error.type, error.code].some((value) => typeof value === 'string' && CODEX_STREAM_LIMIT_CODES.has(value))) {
				return other('codex_stream_error');
			}

			return classifyCodex({ status: 429, headers, body: { error } }, now);
		}
		if (error.type !== 'rate_limit_error') return other('anthropic_stream_error');

		return classifyAnthropic({ status: 429, headers, body: { type: 'error', error } }, now);
	}
}
