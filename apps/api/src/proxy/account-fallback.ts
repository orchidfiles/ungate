import { logger } from 'src/utils/logger';

import { OAuthAccounts, type OAuthAccountRow } from '../database/oauth-accounts';
import { UsageFetcher } from '../usage/usage-fetcher';
import { AccountUsageStore } from '../usage/usage-store';

import { UpstreamHeadersTimeout } from './upstream-fetch';
import { UsageLimitClassifier, type UsageLimitClassification } from './usage-limit-classifier';

import type { SubscriptionProvider } from '@ungate/shared';

/** Minimal shape both `OAuth.getValidToken` and `OpenAIOAuthService.getValidToken` return. */
export interface PinnedCredentials {
	localAccountId?: string;
	credentialVersion?: number;
}

/**
 * Result of inspecting one upstream attempt. `limit` set → the account hit its usage limit and the
 * coordinator rotates; otherwise `response` (possibly rebuilt because its body was read) is final.
 */
export interface InspectedAttempt {
	response: Response;
	limit?: UsageLimitClassification;
	/**
	 * Set when the attempt failed transiently before anything reached the client (e.g. an early
	 * SSE `overloaded_error`); names the failure for logs. The coordinator retries it like a 5xx.
	 */
	transient?: string;
}

export interface AccountFallbackOptions<C extends PinnedCredentials> {
	provider: SubscriptionProvider;
	/** Valid credentials for exactly this local account (refreshing if needed), or null. */
	getCredentials: (accountId: string) => Promise<C | null>;
	/**
	 * One upstream attempt pinned to `credentials`, including the same-account 401 refresh retry.
	 * Returns the final response and the credentials it was sent with (refreshed ones after a retry).
	 */
	send: (credentials: C) => Promise<{ response: Response; credentials: C }>;
	/**
	 * Decides whether a response is a usage limit. Defaults to `AccountFallback.inspectHttp`
	 * (HTTP status/headers/body). A streaming pre-commit gate can wrap it to also peek at early SSE
	 * error events; it must return a replacement response that preserves any bytes it consumed.
	 */
	inspect?: (response: Response) => Promise<InspectedAttempt>;
	/** Downstream cancellation: stops fallback before the next attempt. */
	signal?: AbortSignal;
}

export type AccountFallbackOutcome<C> =
	| {
			kind: 'response';
			response: Response;
			credentials: C;
			accountId: string;
			attempts: number;
			/** Limit reason of the last account rotated away from, when the request was served by a fallback. */
			rotationReason: string | null;
	  }
	/** No account in the pool had usable credentials and none was sent to — callers keep their 401. */
	| { kind: 'no_credentials' }
	/** Every candidate was usage-limited (or auto-switch is off): answer 429 locally. */
	| {
			kind: 'limited';
			message: string;
			reason: string;
			/** Last account tried before giving up. */
			accountId: string;
			attempts: number;
			retryAt: number | null;
			estimated: boolean;
			headers: Record<string, string>;
	  };

interface Candidate {
	account: OAuthAccountRow;
	/** Policy revision observed when this account was selected; the CAS guard for the next switch. */
	revision: number;
}

interface LimitRecord {
	accountId: string;
	reason: string;
	/** Safe upstream retry hints from the last limited response. */
	headers: Record<string, string>;
}

interface AuthFailure<C> {
	accountId: string;
	credentials: C;
	status: number;
	headers: Headers;
	body: string;
}

/** Rotation reason for an account whose credentials cannot be used (needs login, removed, rejected after refresh). */
const AUTH_ROTATION = 'auth';

const PROVIDER_LABEL: Record<SubscriptionProvider, string> = { claude: 'Claude', openai: 'ChatGPT' };

/** Hop-by-hop / representation headers that are stale once a body has been read and re-wrapped. */
const STALE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

/** Error bodies are small JSON objects; never buffer an unbounded body just to classify it. */
const ERROR_BODY_LIMIT = 64 * 1024;

/** Upstream retry hints that are safe to forward to the client. */
const SAFE_RETRY_HEADERS = ['retry-after', 'retry-after-ms', 'x-should-retry'];

/** Rotation reason for an account left after repeated transient upstream failures (it is not cooled down). */
const TRANSIENT_ROTATION = 'upstream_transient';

/** A pool-wide limit lifting later than this is not worth a client's automatic retries. */
const LONG_LIMIT_MS = 60_000;

/** Upstream statuses that say "try again shortly" rather than "this request is wrong". */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504, 529]);

/**
 * Pre-commit retry budget for transient failures: at most `maxRetries` extra attempts per request,
 * jittered exponential backoff from `baseDelayMs`, and no waits longer than `maxDelayMs` (a longer
 * `retry-after` is answered to the client instead of held open).
 */
export const UPSTREAM_RETRY = { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 10_000 };

interface RetryBudget {
	spent: number;
	/** Transient failures seen per account in this request. */
	failures: Map<string, number>;
}

/** Delay the upstream asked for via `retry-after-ms` or `retry-after` (seconds or HTTP date), if any. */
function retryAfterMs(headers: Headers): number | undefined {
	const ms = Number(headers.get('retry-after-ms'));
	if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
	const value = headers.get('retry-after');
	if (value === null) return undefined;
	const seconds = Number(value);
	if (value.trim() !== '' && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);

	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Network-level failure of the upstream call (fetch rejects with TypeError) or a time-to-headers timeout. */
function isTransportFailure(error: unknown): boolean {
	return error instanceof TypeError || error instanceof UpstreamHeadersTimeout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const aborted = () => (signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
		if (signal?.aborted) return reject(aborted());
		const onAbort = () => {
			clearTimeout(timer);
			reject(aborted());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function release(response: Response): Promise<void> {
	if (response.bodyUsed || !response.body) return;
	await response.body.cancel().catch(() => undefined);
}

export class AccountFallback {
	/**
	 * Runs one incoming request against the provider's subscription accounts. Each attempt is pinned
	 * to one local account id; on a recognized usage limit the account is cooled down and, when
	 * auto-switch is on, the policy is CAS-switched to the next eligible account and the request is
	 * retried there. An account whose credentials cannot be used (needs login, removed, no valid
	 * token, or a 401 that survived the refresh retry) rotates the same way with reason `auth`.
	 * Each account is tried at most once; cooldowns are never waited through.
	 * No database transaction spans a network call.
	 */
	static async run<C extends PinnedCredentials>(options: AccountFallbackOptions<C>): Promise<AccountFallbackOutcome<C>> {
		const { provider } = options;
		const inspect = options.inspect ?? ((response: Response) => this.inspectHttp(provider, response));
		const attempted = new Set<string>();
		let lastLimit: LimitRecord | undefined;
		/** Why the request last moved off an account: a limit reason, or `auth`. */
		let lastRotation: string | null = null;
		/** The last upstream 401, answered as-is when no account in the pool could serve the request. */
		let lastAuthFailure: AuthFailure<C> | undefined;
		const budget: RetryBudget = { spent: 0, failures: new Map() };
		let current = this.initialCandidate(provider);

		while (current) {
			options.signal?.throwIfAborted();
			const { account, revision } = current;
			attempted.add(account.id);
			const fresh = OAuthAccounts.get(account.id, provider);

			if (!fresh || !OAuthAccounts.isEligible(fresh)) {
				const unavailable = !fresh ? 'removed' : fresh.needsLogin ? 'needs_login' : 'cooling_down';
				if (fresh && unavailable === 'cooling_down') {
					lastLimit = { accountId: fresh.id, reason: fresh.cooldownReason ?? 'cooling_down', headers: {} };
					lastRotation = lastLimit.reason;
				} else {
					lastRotation = AUTH_ROTATION;
				}
				logger.log(`[accounts] ${provider} account ${account.id} unavailable (${unavailable}), skipping`);
				current = this.advance(
					provider,
					revision,
					account.id,
					unavailable === 'cooling_down' ? 'cooling_down' : AUTH_ROTATION,
					attempted
				);
				continue;
			}

			const credentials = await options.getCredentials(account.id);
			if (!credentials || (credentials.localAccountId !== undefined && credentials.localAccountId !== account.id)) {
				lastRotation = AUTH_ROTATION;
				logger.log(`[accounts] ${provider} account ${account.id} has no usable credentials, skipping`);
				current = this.advance(provider, revision, account.id, AUTH_ROTATION, attempted);
				continue;
			}

			options.signal?.throwIfAborted();
			let sent: { response: Response; credentials: C };
			try {
				sent = await options.send(credentials);
			} catch (error) {
				if (options.signal?.aborted || !isTransportFailure(error)) throw error;
				const retry = this.planRetry(provider, current, `transport: ${String(error)}`, undefined, budget, attempted);
				if (!retry) throw error;
				if (retry.next.account.id !== account.id) lastRotation = TRANSIENT_ROTATION;
				await sleep(retry.delayMs, options.signal);
				current = retry.next;
				continue;
			}
			AccountUsageStore.recordHeaders(provider, account.id, sent.response.headers);

			// `send` already refreshed once and retried on 401, so a 401 here means this account's
			// credentials are unusable for now; another account may still serve the request.
			if (sent.response.status === 401) {
				const refreshed = sent.credentials.credentialVersion !== credentials.credentialVersion;
				// Rejected even with freshly refreshed credentials: the grant is dead. A refresh that
				// failed (same generation) may be transient, so the account only rotates.
				if (refreshed && sent.credentials.credentialVersion !== undefined) {
					OAuthAccounts.markAuthFailed(account.id, sent.credentials.credentialVersion);
				}
				lastAuthFailure = {
					accountId: account.id,
					credentials: sent.credentials,
					status: sent.response.status,
					headers: this.sanitizeHeaders(sent.response.headers),
					body: await this.readBounded(sent.response)
				};
				lastRotation = AUTH_ROTATION;
				logger.log(`[accounts] ${provider} account ${account.id} rejected (401${refreshed ? ' after refresh' : ''}), skipping`);
				current = this.advance(provider, revision, account.id, AUTH_ROTATION, attempted);
				continue;
			}

			const inspected = await inspect(sent.response);

			const transient = inspected.limit
				? undefined
				: (inspected.transient ?? (TRANSIENT_STATUSES.has(sent.response.status) ? `http_${sent.response.status}` : undefined));
			if (transient) {
				const retry = this.planRetry(provider, current, transient, sent.response.headers, budget, attempted);
				if (retry) {
					await release(sent.response);
					await release(inspected.response);
					if (retry.next.account.id !== account.id) lastRotation = TRANSIENT_ROTATION;
					await sleep(retry.delayMs, options.signal);
					current = retry.next;
					continue;
				}
			}

			if (!inspected.limit) {
				if (attempted.size > 1) logger.log(`[accounts] ${provider} request served by fallback account ${account.id}`);

				return {
					kind: 'response',
					response: inspected.response,
					credentials: sent.credentials,
					accountId: account.id,
					attempts: attempted.size,
					rotationReason: attempted.size > 1 ? lastRotation : null
				};
			}

			const { limit } = inspected;
			await release(sent.response);
			await release(inspected.response);
			const until = limit.resetAt ?? Date.now();
			if (OAuthAccounts.markCooldown(account.id, until, limit.reason, limit.estimated, sent.credentials.credentialVersion)) {
				// Picks up an upgrade promptly; the fetch can only lift the cooldown, never extend it.
				UsageFetcher.refreshAfterCooldown(provider, account.id);
			}
			lastLimit = { accountId: account.id, reason: limit.reason, headers: this.safeRetryHeaders(sent.response.headers) };
			lastRotation = limit.reason;
			logger.log(
				`[accounts] ${provider} account ${account.id} usage limit (${limit.reason}); cooldown until ${new Date(until).toISOString()}${limit.estimated ? ' (estimated)' : ''}`
			);
			current = this.advance(provider, revision, account.id, limit.reason, attempted);
		}

		if (lastLimit) return this.limitedOutcome(provider, lastLimit, attempted.size);
		if (lastAuthFailure) {
			return {
				kind: 'response',
				response: new Response(lastAuthFailure.body, { status: lastAuthFailure.status, headers: lastAuthFailure.headers }),
				credentials: lastAuthFailure.credentials,
				accountId: lastAuthFailure.accountId,
				attempts: attempted.size,
				rotationReason: attempted.size > 1 ? lastRotation : null
			};
		}

		return { kind: 'no_credentials' };
	}

	/**
	 * Default HTTP-level inspection. Only 429s can be usage limits for either provider, so other
	 * responses pass through untouched (body unread). A 429 body is read once to classify; a
	 * non-limit 429 is rebuilt with the same status/body and stale length/encoding headers removed.
	 */
	static async inspectHttp(provider: SubscriptionProvider, response: Response): Promise<InspectedAttempt> {
		if (response.status !== 429) return { response };
		const text = await this.readBounded(response);
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			body = undefined;
		}
		const classification = UsageLimitClassifier.classify(provider, { status: response.status, headers: response.headers, body });
		if (classification.kind === 'usage_limit') return { response, limit: classification };

		return {
			response: new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: this.sanitizeHeaders(response.headers)
			})
		};
	}

	/** Reads at most `ERROR_BODY_LIMIT` bytes of an error body, then cancels the rest. */
	private static async readBounded(response: Response): Promise<string> {
		if (!response.body) return '';
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let text = '';
		let size = 0;
		try {
			while (size < ERROR_BODY_LIMIT) {
				const { done, value } = await reader.read();
				if (done) return text + decoder.decode();
				size += value.byteLength;
				text += decoder.decode(value, { stream: true });
			}
			await reader.cancel().catch(() => undefined);

			return text + decoder.decode();
		} catch {
			return text;
		} finally {
			reader.releaseLock();
		}
	}

	/** Copy of `headers` without hop-by-hop or stale representation headers. */
	static sanitizeHeaders(headers: Headers): Headers {
		const result = new Headers();
		for (const [name, value] of headers.entries()) {
			if (!STALE_HEADERS.has(name.toLowerCase())) result.append(name, value);
		}

		return result;
	}

	/** Retry hints from an upstream error response that are safe to forward downstream. */
	static safeRetryHeaders(headers: Headers): Record<string, string> {
		const result: Record<string, string> = {};
		for (const name of SAFE_RETRY_HEADERS) {
			const value = headers.get(name);
			if (value !== null && /^[\w .,:+-]{1,64}$/.test(value)) result[name] = value;
		}

		return result;
	}

	/**
	 * Where to retry a transient upstream failure before anything was committed, after waiting
	 * `delayMs` (the upstream's `retry-after`, else jittered exponential backoff). The first failure
	 * on an account retries that account; a second one moves the request to the next eligible
	 * account through the usual CAS switch, without cooling the failing account down. Undefined
	 * when the budget is spent, no account is left, or the upstream asks for a longer wait than a
	 * request should hold.
	 */
	private static planRetry(
		provider: SubscriptionProvider,
		current: Candidate,
		why: string,
		headers: Headers | undefined,
		budget: RetryBudget,
		attempted: Set<string>
	): { next: Candidate; delayMs: number } | undefined {
		if (budget.spent >= UPSTREAM_RETRY.maxRetries) return undefined;
		const hinted = headers ? retryAfterMs(headers) : undefined;
		if (hinted !== undefined && hinted > UPSTREAM_RETRY.maxDelayMs) {
			logger.log(`[accounts] ${provider} transient failure (${why}); retry-after ${hinted}ms is too long, not retrying`);

			return undefined;
		}
		const { account, revision } = current;
		const failures = (budget.failures.get(account.id) ?? 0) + 1;
		budget.failures.set(account.id, failures);
		// Another account may sit on a healthier path; with none left, the same account is retried.
		let next = failures >= 2 ? this.advance(provider, revision, account.id, TRANSIENT_ROTATION, attempted) : undefined;
		if (!next) {
			const fresh = OAuthAccounts.get(account.id, provider);
			next = fresh && OAuthAccounts.isEligible(fresh) ? { account: fresh, revision } : undefined;
		}
		if (!next) return undefined;
		budget.spent++;
		const backoff = UPSTREAM_RETRY.baseDelayMs * 2 ** (budget.spent - 1);
		const delayMs = hinted ?? Math.round(backoff / 2 + Math.random() * (backoff / 2));
		logger.log(
			`[accounts] ${provider} transient failure on ${account.id} (${why}); retrying on ${next.account.id} in ${delayMs}ms`
		);

		return { next, delayMs };
	}

	private static initialCandidate(provider: SubscriptionProvider): Candidate | undefined {
		const { policy, account } = OAuthAccounts.selection(provider);
		if (account) return { account, revision: policy.revision };
		if (!policy.autoSwitch || policy.activeAccountId) return undefined;
		// Nothing active (e.g. the last active account was removed while others were cooling down):
		// adopt the first eligible saved account, CAS-guarded so a concurrent manual pick wins.
		const first = OAuthAccounts.nextEligible(provider, null);
		if (!first || !OAuthAccounts.compareAndSelect(provider, policy.revision, null, first.id, 'auto_recover')) return undefined;
		const after = OAuthAccounts.selection(provider);

		return after.account?.id === first.id ? { account: after.account, revision: after.policy.revision } : undefined;
	}

	/**
	 * Next account for this request after `failedId` failed, or undefined to stop. Never overrides
	 * a newer selection: if the CAS loses (manual pick or another request switched first), the
	 * request follows the current selection when it is an untried eligible account.
	 */
	private static advance(
		provider: SubscriptionProvider,
		revision: number,
		failedId: string,
		reason: string,
		attempted: Set<string>
	): Candidate | undefined {
		if (!OAuthAccounts.policy(provider).autoSwitch) return undefined;
		const next = OAuthAccounts.switchToNextEligible(provider, revision, failedId, reason, attempted);
		const after = OAuthAccounts.selection(provider);

		if (next) {
			logger.log(`[accounts] ${provider} switched active account ${failedId} → ${next.id} (${reason})`);

			return { account: next, revision: after.account?.id === next.id ? after.policy.revision : revision + 1 };
		}
		if (after.account && !attempted.has(after.account.id) && OAuthAccounts.isEligible(after.account)) {
			logger.log(`[accounts] ${provider} following concurrent selection ${after.account.id} after ${failedId} (${reason})`);

			return { account: after.account, revision: after.policy.revision };
		}

		return undefined;
	}

	private static limitedOutcome<C>(
		provider: SubscriptionProvider,
		last: LimitRecord,
		attempts: number
	): AccountFallbackOutcome<C> {
		const now = Date.now();
		const label = PROVIDER_LABEL[provider];
		const autoSwitch = OAuthAccounts.policy(provider).autoSwitch;
		const failed = OAuthAccounts.get(last.accountId, provider);
		let retryAt: number | null;
		let estimated = false;

		if (autoSwitch) {
			retryAt = OAuthAccounts.earliestCooldownEnd(provider, now);
			estimated = OAuthAccounts.list(provider).some((row) => row.cooldownUntil === retryAt && row.cooldownEstimated);
		} else {
			retryAt = failed?.cooldownUntil && failed.cooldownUntil > now ? failed.cooldownUntil : null;
			estimated = !!failed?.cooldownEstimated;
		}

		const when = retryAt ? `${new Date(retryAt).toISOString()}${estimated ? ' (estimated)' : ''}` : null;
		const name = failed ? `"${failed.label}"` : 'The active account';
		const message = autoSwitch
			? `All saved ${label} subscription accounts have reached their usage limit.${when ? ` Earliest retry: ${when}.` : ' Reconnect or add another account in Ungate.'}`
			: `${label} account ${name} has reached its usage limit and automatic account switching is off.${when ? ` Retry after ${when},` : ''} or select another account in Ungate.`;
		const headers = this.limitHeaders(provider, last.headers, retryAt, now);

		return { kind: 'limited', message, reason: last.reason, accountId: last.accountId, attempts, retryAt, estimated, headers };
	}

	/**
	 * Headers for a pool-wide 429. Upstream hints are kept, but `retry-after` reflects the earliest
	 * account-wide retry time when known. Claude clients also get Anthropic's own unified-limit
	 * signal (`rejected` with the reset in epoch seconds) so they report a usage limit, not a
	 * transient 429; when the reset is more than `LONG_LIMIT_MS` away they are told not to retry.
	 */
	static limitHeaders(
		provider: SubscriptionProvider,
		upstream: Record<string, string>,
		retryAt: number | null,
		now: number
	): Record<string, string> {
		const headers: Record<string, string> = { ...upstream };
		if (retryAt) headers['retry-after'] = String(Math.max(1, Math.ceil((retryAt - now) / 1000)));
		if (provider !== 'claude') return headers;
		headers['anthropic-ratelimit-unified-status'] = 'rejected';
		if (retryAt) {
			headers['anthropic-ratelimit-unified-reset'] = String(Math.ceil(retryAt / 1000));
			if (retryAt - now > LONG_LIMIT_MS) headers['x-should-retry'] = 'false';
		}

		return headers;
	}
}
