import { logger } from 'src/utils/logger';

import { OAuth } from '../auth/oauth';
import { OpenAIOAuthService } from '../auth/openai/openai-oauth-service';
import { config } from '../config';
import { OAuthAccounts, type OAuthAccountRow } from '../database/oauth-accounts';
import { RequestBuilder } from '../proxy/request-builder';

import { parseClaudeUsageBody, parseCodexUsageBody } from './usage-parsers';
import { AccountUsageStore } from './usage-store';

import type { SubscriptionProvider, UsageWindow } from '@ungate/shared';

/** Accounts fetched (successfully or not) more recently than this are not fetched again. */
export const USAGE_FETCH_THROTTLE_MS = 60_000;
const USAGE_FETCH_TIMEOUT_MS = 10_000;

interface Token {
	accessToken: string;
	credentialVersion?: number;
	/** ChatGPT workspace id (`chatgpt-account-id`). */
	workspaceId?: string | null;
}

type FetchResult = { ok: true; windows: UsageWindow[]; planType: string | null } | { ok: false; status: number; error: string };

class UsageFetchError extends Error {}

/**
 * Live usage fetches from the providers' subscription usage endpoints. Read-only with respect to
 * account state: never cools an account down or marks it as needing login (token refresh still
 * goes through the shared account token service, so a rejected refresh token is recorded there).
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

		let result = await this.request(provider, token);
		if (!result.ok && result.status === 401) {
			const refreshed = await this.refreshToken(provider, accountId, token.credentialVersion);
			if (!refreshed) throw new UsageFetchError('Login expired; reconnect this account');
			result = await this.request(provider, refreshed);
		}
		if (!result.ok) throw new UsageFetchError(result.error);
		// The account may have been removed while the request was in flight.
		if (!OAuthAccounts.get(accountId, provider)) return;
		AccountUsageStore.recordEndpoint(accountId, result.windows, result.planType);
	}

	private static async token(provider: SubscriptionProvider, accountId: string): Promise<Token | null> {
		if (provider === 'claude') {
			const creds = await OAuth.getValidToken(accountId);

			return creds?.localAccountId === accountId ? creds : null;
		}
		const creds = await OpenAIOAuthService.getValidToken(accountId);

		return creds?.localAccountId === accountId && creds.accountId ? { ...creds, workspaceId: creds.accountId } : null;
	}

	private static async refreshToken(
		provider: SubscriptionProvider,
		accountId: string,
		credentialVersion: number | undefined
	): Promise<Token | null> {
		if (provider === 'claude') return OAuth.refreshAccountToken(accountId, credentialVersion);
		const creds = await OpenAIOAuthService.refreshAccountToken(accountId, credentialVersion);

		return creds?.accountId ? { ...creds, workspaceId: creds.accountId } : null;
	}

	private static async request(provider: SubscriptionProvider, token: Token): Promise<FetchResult> {
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

		if (provider === 'claude') return { ok: true, windows: parseClaudeUsageBody(body), planType: null };
		const parsed = parseCodexUsageBody(body);

		return { ok: true, windows: parsed.windows, planType: parsed.planType };
	}
}
