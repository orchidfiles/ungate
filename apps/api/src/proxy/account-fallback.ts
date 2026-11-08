import { logger } from 'src/utils/logger';

import { OAuthAccounts, type OAuthAccountRow } from '../database/oauth-accounts';
import { UsageFetcher } from '../usage/usage-fetcher';
import { AccountUsageStore } from '../usage/usage-store';

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
	/** No usable credentials at all (no account, needs login, refresh failed) — callers keep their 401. */
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

const PROVIDER_LABEL: Record<SubscriptionProvider, string> = { claude: 'Claude', openai: 'ChatGPT' };

/** Hop-by-hop / representation headers that are stale once a body has been read and re-wrapped. */
const STALE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

/** Error bodies are small JSON objects; never buffer an unbounded body just to classify it. */
const ERROR_BODY_LIMIT = 64 * 1024;

/** Upstream retry hints that are safe to forward to the client. */
const SAFE_RETRY_HEADERS = ['retry-after', 'retry-after-ms', 'x-should-retry'];

async function release(response: Response): Promise<void> {
	if (response.bodyUsed || !response.body) return;
	await response.body.cancel().catch(() => undefined);
}

export class AccountFallback {
	/**
	 * Runs one incoming request against the provider's subscription accounts. Each attempt is pinned
	 * to one local account id; on a recognized usage limit the account is cooled down and, when
	 * auto-switch is on, the policy is CAS-switched to the next eligible account and the request is
	 * retried there. Each account is tried at most once; cooldowns are never waited through.
	 * No database transaction spans a network call.
	 */
	static async run<C extends PinnedCredentials>(options: AccountFallbackOptions<C>): Promise<AccountFallbackOutcome<C>> {
		const { provider } = options;
		const inspect = options.inspect ?? ((response: Response) => this.inspectHttp(provider, response));
		const attempted = new Set<string>();
		let lastLimit: LimitRecord | undefined;
		let current = this.initialCandidate(provider);

		while (current) {
			options.signal?.throwIfAborted();
			const { account, revision } = current;
			attempted.add(account.id);
			const fresh = OAuthAccounts.get(account.id, provider);

			if (!fresh || !OAuthAccounts.isEligible(fresh)) {
				const coolingDown = !!fresh && !fresh.needsLogin;
				// Only usage limits rotate accounts: an unusable (needs-login / removed) first account keeps the legacy 401.
				if (!coolingDown && !lastLimit) return { kind: 'no_credentials' };
				if (coolingDown) lastLimit = { accountId: fresh.id, reason: fresh.cooldownReason ?? 'cooling_down', headers: {} };
				const reason = coolingDown ? 'cooling_down' : fresh ? 'needs_login' : 'removed';
				logger.log(`[accounts] ${provider} account ${account.id} unavailable (${reason}), skipping`);
				current = this.advance(provider, revision, account.id, reason, attempted);
				continue;
			}

			const credentials = await options.getCredentials(account.id);
			if (!credentials || (credentials.localAccountId !== undefined && credentials.localAccountId !== account.id)) {
				if (!lastLimit) return { kind: 'no_credentials' };
				logger.log(`[accounts] ${provider} account ${account.id} has no usable credentials, skipping`);
				current = this.advance(provider, revision, account.id, 'no_credentials', attempted);
				continue;
			}

			options.signal?.throwIfAborted();
			const sent = await options.send(credentials);
			AccountUsageStore.recordHeaders(provider, account.id, sent.response.headers);
			const inspected = await inspect(sent.response);

			if (!inspected.limit) {
				if (attempted.size > 1) logger.log(`[accounts] ${provider} request served by fallback account ${account.id}`);

				return {
					kind: 'response',
					response: inspected.response,
					credentials: sent.credentials,
					accountId: account.id,
					attempts: attempted.size,
					rotationReason: lastLimit?.reason ?? null
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
			logger.log(
				`[accounts] ${provider} account ${account.id} usage limit (${limit.reason}); cooldown until ${new Date(until).toISOString()}${limit.estimated ? ' (estimated)' : ''}`
			);
			current = this.advance(provider, revision, account.id, limit.reason, attempted);
		}

		return lastLimit ? this.limitedOutcome(provider, lastLimit, attempted.size) : { kind: 'no_credentials' };
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
		// Upstream hints are kept, but retry-after reflects the earliest *account-wide* retry time when known.
		const headers: Record<string, string> = { ...last.headers };
		if (retryAt) headers['retry-after'] = String(Math.max(1, Math.ceil((retryAt - now) / 1000)));

		return { kind: 'limited', message, reason: last.reason, accountId: last.accountId, attempts, retryAt, estimated, headers };
	}
}
