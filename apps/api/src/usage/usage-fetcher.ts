import { logger } from 'src/utils/logger';

import { GeminiOAuthService } from '../auth/gemini/gemini-oauth-service';
import { OAuth } from '../auth/oauth';
import { OpenAIOAuthService } from '../auth/openai/openai-oauth-service';
import { config } from '../config';
import { OAuthAccounts, type OAuthAccountRow } from '../database/oauth-accounts';
import { RequestBuilder } from '../proxy/request-builder';

import { shouldLiftCooldown } from './upgrade-detector';
import {
	parseClaudeProfilePlan,
	parseClaudeUsageBody,
	parseCodexUsageBody,
	parseGeminiQuotaBuckets,
	type UsageEndpointResult
} from './usage-parsers';
import { AccountUsageStore } from './usage-store';

import type { SubscriptionProvider, UsageWindow } from '@ungate/shared';

/** Accounts fetched (successfully or not) more recently than this are not fetched again. */
export const USAGE_FETCH_THROTTLE_MS = 60_000;
const USAGE_FETCH_TIMEOUT_MS = 10_000;

interface Token {
	accessToken: string;
	credentialVersion?: number;
	/** ChatGPT workspace id (`chatgpt-account-id`), or the Gemini Code Assist project id. */
	workspaceId?: string | null;
}

type FetchResult = ({ ok: true } & UsageEndpointResult) | { ok: false; status: number; error: string };

class UsageFetchError extends Error {}

/**
 * Live usage fetches from the providers' subscription usage endpoints. Never cools an account down
 * or marks it as needing login (token refresh still goes through the shared account token service,
 * so a rejected refresh token is recorded there). The only state it writes is the last known plan
 * tier and, when that tier went up or every endpoint window is back under 100%, an early cooldown lift.
 */
export class UsageFetcher {
	private static lastAttempt = new Map<string, number>();
	private static inFlight = new Map<string, Promise<void>>();

	/** Refreshes `accountId`, or every account of `provider` that does not need login. */
	static async refresh(provider: SubscriptionProvider, accountId?: string): Promise<void> {
		const rows = accountId
			? [OAuthAccounts.get(accountId, provider)].filter((row): row is OAuthAccountRow => !!row)
			: OAuthAccounts.list(provider);
		await Promise.all(rows.filter((row) => !row.needsLogin).map((row) => this.refreshAccount(provider, row.id)));
	}

	/**
	 * Fire-and-forget refresh when an account enters cooldown, so an upgrade made in response to the
	 * limit is noticed without waiting for the dashboard poll. The per-account throttle still applies.
	 */
	static refreshAfterCooldown(provider: SubscriptionProvider, accountId: string): void {
		if (!this.cooldownRefreshEnabled) return;
		setImmediate(() => void this.refresh(provider, accountId).catch(() => undefined));
	}

	/** Disabled in tests that count upstream fetches. */
	static cooldownRefreshEnabled = process.env.VITEST === undefined;

	/** Test helper. */
	static reset(): void {
		this.lastAttempt.clear();
		this.inFlight.clear();
	}

	private static refreshAccount(provider: SubscriptionProvider, accountId: string): Promise<void> {
		const existing = this.inFlight.get(accountId);
		if (existing) return existing;
		const last = this.lastAttempt.get(accountId);
		if (last !== undefined && Date.now() - last < USAGE_FETCH_THROTTLE_MS) return Promise.resolve();

		this.lastAttempt.set(accountId, Date.now());
		const promise = this.fetchAccount(provider, accountId)
			.catch((error) => {
				const message = error instanceof UsageFetchError ? error.message : 'Usage request failed';
				logger.log(`[usage] ${provider} account ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
				AccountUsageStore.recordError(accountId, message);
			})
			.finally(() => this.inFlight.delete(accountId));
		this.inFlight.set(accountId, promise);

		return promise;
	}

	private static async fetchAccount(provider: SubscriptionProvider, accountId: string): Promise<void> {
		const token = await this.token(provider, accountId);
		if (!token) throw new UsageFetchError('No valid login for this account');

		let used = token;
		let result = await this.request(provider, token);
		if (!result.ok && result.status === 401) {
			const refreshed = await this.refreshToken(provider, accountId, token.credentialVersion);
			if (!refreshed) throw new UsageFetchError('Login expired; reconnect this account');
			used = refreshed;
			result = await this.request(provider, refreshed);
		}
		if (!result.ok) throw new UsageFetchError(result.error);
		// The account may have been removed while the request was in flight.
		const row = OAuthAccounts.get(accountId, provider);
		if (!row) return;
		AccountUsageStore.recordEndpoint(accountId, result);
		this.liftCooldownIfUpgraded(row, result.windows, result.planType, used.credentialVersion);
	}

	/**
	 * The one place usage data touches account state: it may clear an existing cooldown (plan upgrade
	 * or every endpoint window back under 100%), never create or extend one, and never touches
	 * needs-login.
	 */
	private static liftCooldownIfUpgraded(
		row: OAuthAccountRow,
		windows: UsageWindow[],
		planType: string | null,
		credentialVersion: number | undefined
	): void {
		const now = Date.now();
		const reason = shouldLiftCooldown({
			previousPlan: row.planType,
			newPlan: planType,
			windows,
			cooldownReason: row.cooldownReason,
			cooldownUntil: row.cooldownUntil,
			now
		});
		if (planType && planType !== row.planType) OAuthAccounts.setPlanType(row.id, planType);
		if (!reason) return;
		if (OAuthAccounts.clearCooldown(row.id, credentialVersion, row.provider as SubscriptionProvider)) {
			logger.log(`[usage] ${row.provider} account ${row.id} cooldown lifted (${reason})`);
		}
	}

	private static async token(provider: SubscriptionProvider, accountId: string): Promise<Token | null> {
		if (provider === 'claude') {
			const creds = await OAuth.getValidToken(accountId);

			return creds?.localAccountId === accountId ? creds : null;
		}
		const creds =
			provider === 'gemini'
				? await GeminiOAuthService.getValidToken(accountId)
				: await OpenAIOAuthService.getValidToken(accountId);

		return creds?.localAccountId === accountId && creds.accountId ? { ...creds, workspaceId: creds.accountId } : null;
	}

	private static async refreshToken(
		provider: SubscriptionProvider,
		accountId: string,
		credentialVersion: number | undefined
	): Promise<Token | null> {
		if (provider === 'claude') return OAuth.refreshAccountToken(accountId, credentialVersion);
		const creds =
			provider === 'gemini'
				? await GeminiOAuthService.refreshAccountToken(accountId, credentialVersion)
				: await OpenAIOAuthService.refreshAccountToken(accountId, credentialVersion);

		return creds?.accountId ? { ...creds, workspaceId: creds.accountId } : null;
	}

	/** Code Assist quota buckets for the account's managed project (`workspaceId`). */
	private static async geminiRequest(token: Token): Promise<FetchResult> {
		let response: Response;
		try {
			response = await fetch(`${config.gemini.codeAssistUrl}:retrieveUserQuota`, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token.accessToken}`,
					'Content-Type': 'application/json',
					'User-Agent': config.gemini.userAgent
				},
				body: JSON.stringify({ project: token.workspaceId }),
				signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS)
			});
		} catch (error) {
			const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
			throw new UsageFetchError(timedOut ? 'Usage request timed out' : 'Usage request failed');
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);

			return { ok: false, status: response.status, error: `Usage request failed (HTTP ${response.status})` };
		}
		const body: unknown = await response.json().catch(() => undefined);
		if (body === undefined) return { ok: false, status: response.status, error: 'Usage response was not JSON' };

		// The tier comes from `loadCodeAssist` at login; quota buckets do not report it.
		return { ok: true, windows: parseGeminiQuotaBuckets(body), planType: null, cleared: [] };
	}

	private static async request(provider: SubscriptionProvider, token: Token): Promise<FetchResult> {
		if (provider === 'gemini') return this.geminiRequest(token);
		const headers: Record<string, string> =
			provider === 'claude'
				? {
						Accept: 'application/json',
						Authorization: `Bearer ${token.accessToken}`,
						'anthropic-beta': config.anthropic.usageBeta,
						'User-Agent': RequestBuilder.getClaudeOAuthUserAgent()
					}
				: {
						accept: 'application/json',
						authorization: `Bearer ${token.accessToken}`,
						'chatgpt-account-id': token.workspaceId ?? '',
						originator: 'codex_cli_rs'
					};
		const url = provider === 'claude' ? config.anthropic.usageUrl : config.openai.usageUrl;

		let response: Response;
		try {
			response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS) });
		} catch (error) {
			const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
			throw new UsageFetchError(timedOut ? 'Usage request timed out' : 'Usage request failed');
		}

		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);

			return { ok: false, status: response.status, error: `Usage request failed (HTTP ${response.status})` };
		}

		const body: unknown = await response.json().catch(() => undefined);
		if (body === undefined) return { ok: false, status: response.status, error: 'Usage response was not JSON' };

		if (provider === 'claude') {
			return { ok: true, ...parseClaudeUsageBody(body), planType: await this.claudePlan(headers) };
		}

		return { ok: true, ...parseCodexUsageBody(body) };
	}

	/** Best effort: a failed profile fetch only means the tier is unknown for this refresh. */
	private static async claudePlan(headers: Record<string, string>): Promise<string | null> {
		try {
			const response = await fetch(config.anthropic.profileUrl, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS)
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);

				return null;
			}

			const body: unknown = await response.json().catch(() => undefined);

			return parseClaudeProfilePlan(body);
		} catch {
			return null;
		}
	}
}
