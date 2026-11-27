import { OAuthAccounts, type OAuthAccountRow } from '../database/oauth-accounts';

import type { OAuthCredentials } from './base-provider';
import type { SubscriptionProvider } from '@ungate/shared';

export interface RefreshResult {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt: number;
}
export class AccountRefreshRejected extends Error {}

/**
 * Upper bound on one token-refresh round trip. A hung token endpoint otherwise holds the request
 * (and every request deduplicated onto the same refresh) for as long as the socket stays open.
 */
export const REFRESH_TIMEOUT_MS = 15_000;

/** Refresh deduplication and credential-generation CAS shared by both OAuth providers. */
export class AccountTokenService {
	private static inFlight = new Map<string, Promise<OAuthCredentials | null>>();

	static credentials(row: OAuthAccountRow): OAuthCredentials {
		return {
			localAccountId: row.id,
			credentialVersion: row.credentialVersion,
			accessToken: row.accessToken,
			refreshToken: row.refreshToken,
			expiresAt: row.expiresAt,
			email: row.email,
			accountId: row.providerAccountId,
			providerUserId: row.providerUserId
		};
	}

	/**
	 * Valid credentials for `id` (or the active account when omitted), refreshing within `buffer` ms
	 * of expiry. A transient refresh failure falls back to the still-unexpired stored token.
	 */
	static async get(
		provider: SubscriptionProvider,
		id: string | undefined,
		buffer: number,
		refresh: (token: string) => Promise<RefreshResult | null>
	): Promise<OAuthCredentials | null> {
		const row = id ? OAuthAccounts.get(id, provider) : OAuthAccounts.active(provider);
		if (!row || row.needsLogin) return null;
		if (Date.now() < (row.expiresAt ?? 0) - buffer) return this.credentials(row);
		const refreshed = await this.refresh(provider, row.id, refresh, row.credentialVersion);
		if (refreshed) return refreshed;
		const current = OAuthAccounts.get(row.id, provider);

		return current && !current.needsLogin && Date.now() < (current.expiresAt ?? 0) ? this.credentials(current) : null;
	}

	/**
	 * Forces a refresh of exactly this account; concurrent calls for the same credential generation
	 * share one upstream refresh. `expectedVersion` (the generation the failed request used) makes a
	 * 401 retry reuse a newer generation written meanwhile instead of refreshing twice.
	 * Returns null when the account is gone, needs login, or the refresh failed.
	 */
	static async refresh(
		provider: SubscriptionProvider,
		id: string,
		refresh: (token: string) => Promise<RefreshResult | null>,
		expectedVersion?: number
	): Promise<OAuthCredentials | null> {
		const row = OAuthAccounts.get(id, provider);
		if (!row || row.needsLogin) return null;
		if (expectedVersion !== undefined && row.credentialVersion !== expectedVersion) return this.credentials(row);
		const key = `${provider}:${id}:${row.credentialVersion}`;
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = this.performRefresh(row, refresh).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, promise);

		return promise;
	}

	private static async performRefresh(
		row: OAuthAccountRow,
		refresh: (token: string) => Promise<RefreshResult | null>
	): Promise<OAuthCredentials | null> {
		if (!row.refreshToken) {
			OAuthAccounts.markNeedsLogin(row.id, row.credentialVersion, 'no_refresh_token');

			return null;
		}
		try {
			const result = await refresh(row.refreshToken);
			if (!result) return null;
			const updated = OAuthAccounts.updateCredentials(row.id, row.credentialVersion, {
				...result,
				refreshToken: result.refreshToken ?? row.refreshToken
			});
			// A deleted account is never reinserted; a newer reconnect/refresh wins.
			const current = updated ?? OAuthAccounts.get(row.id);

			return current && !current.needsLogin ? this.credentials(current) : null;
		} catch (error) {
			if (error instanceof AccountRefreshRejected)
				OAuthAccounts.markNeedsLogin(row.id, row.credentialVersion, 'refresh_rejected');

			return null;
		}
	}
}
