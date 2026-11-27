import { randomBytes, createHash } from 'node:crypto';

import { logger } from 'src/utils/logger';

import { config } from '../config';
import { OAuthAccounts } from '../database/oauth-accounts';

import { AccountLoginSessions } from './account-login-sessions';
import { AccountRefreshRejected, AccountTokenService, REFRESH_TIMEOUT_MS } from './account-token-service';

import type { OAuthCredentials } from './base-provider';
import type { AuthStatus, LoginStart, TokenInfo, TokenRefreshResponse } from '../types/index';
import type { AccountLoginCompleteResponse } from '@ungate/shared';

interface TokenExchangeResponse extends TokenRefreshResponse {
	account?: { uuid: string; email_address: string };
}

type AccountTokenInfo = TokenInfo & OAuthCredentials;

export class OAuth {
	static startLogin(accountId?: string): Promise<LoginStart> {
		const verifier = randomBytes(32).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const session = AccountLoginSessions.create('claude', verifier, accountId);
		const sessionId = session.result.sessionId;
		const params = new URLSearchParams({
			code: 'true',
			response_type: 'code',
			client_id: config.claude.clientId,
			redirect_uri: config.claude.oauth.redirectUri,
			scope: 'org:create_api_key user:profile user:inference',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state: sessionId
		});

		return Promise.resolve({ authUrl: `https://claude.ai/oauth/authorize?${params}`, sessionId });
	}

	static async completeLogin(codeInput: string, sessionId: string): Promise<AccountLoginCompleteResponse> {
		const session = AccountLoginSessions.claim(sessionId, 'claude');
		if (!session) return { ok: false, error: 'Session not found, expired, or already used' };
		try {
			const [code, suppliedState] = codeInput.trim().split('#');
			if (suppliedState && suppliedState !== sessionId) throw new Error('OAuth state mismatch');
			const response = await fetch(config.claude.oauth.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'authorization_code',
					client_id: config.claude.clientId,
					redirect_uri: config.claude.oauth.redirectUri,
					code,
					state: sessionId,
					code_verifier: session.verifier
				})
			});
			if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
			const data: TokenExchangeResponse = await response.json();
			if (!data.account?.uuid || !data.access_token || !Number.isFinite(data.expires_in))
				throw new Error('Provider returned invalid credentials or identity');
			if (!AccountLoginSessions.pending(session)) return { ok: false, error: 'Login cancelled or expired' };
			const row = OAuthAccounts.saveLogin(
				'claude',
				{
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
					expiresAt: Date.now() + data.expires_in * 1000
				},
				{ providerUserId: data.account.uuid, email: data.account.email_address },
				session.snapshot,
				session.reconnectId
			);
			AccountLoginSessions.finish(session, row.id);
			logger.log(`✓ Claude OAuth login saved account ${row.id}`);

			return { ok: true, email: row.email ?? undefined, accountId: row.id };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Login failed';
			logger.error(`Claude OAuth login failed: ${message}`);
			AccountLoginSessions.finish(session, undefined, message);

			return { ok: false, error: message };
		}
	}

	static getSession(sessionId: string) {
		return AccountLoginSessions.status(sessionId, 'claude');
	}

	static cancelLogin(sessionId: string): boolean {
		return AccountLoginSessions.cancel(sessionId, 'claude');
	}

	static isTokenExpired(expiresAt: number): boolean {
		return Date.now() >= expiresAt - 5 * 60_000;
	}

	private static async exchangeRefresh(refreshToken: string) {
		const response = await fetch(config.claude.oauth.tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.claude.clientId }),
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
		});
		if (!response.ok) {
			const body: { error?: string } | null = await response.json().catch(() => null);
			if (response.status === 401 || body?.error === 'invalid_grant') throw new AccountRefreshRejected('Refresh rejected');

			return null;
		}
		const data: TokenRefreshResponse = await response.json();
		if (!data.access_token || !Number.isFinite(data.expires_in)) return null;

		return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 };
	}

	private static tokenInfo(credentials: OAuthCredentials | null): AccountTokenInfo | null {
		return credentials
			? { ...credentials, refreshToken: credentials.refreshToken ?? '', expiresAt: credentials.expiresAt ?? 0, isExpired: false }
			: null;
	}

	/**
	 * Without `accountId`, resolves the currently active account (legacy behavior). Callers that
	 * may retry must keep the returned `localAccountId`/`credentialVersion` and pass them to
	 * `refreshAccountToken` so a retry never jumps to a different account.
	 */
	static async getValidToken(accountId?: string): Promise<AccountTokenInfo | null> {
		const credentials = await AccountTokenService.get('claude', accountId, 5 * 60_000, (token) => this.exchangeRefresh(token));

		return this.tokenInfo(credentials);
	}

	static async refreshAccountToken(accountId: string, expectedVersion?: number): Promise<AccountTokenInfo | null> {
		const credentials = await AccountTokenService.refresh(
			'claude',
			accountId,
			(token) => this.exchangeRefresh(token),
			expectedVersion
		);

		return this.tokenInfo(credentials);
	}

	/** Legacy signature: resolve by the captured refresh token, NEVER by current selection. */
	static async refreshToken(refreshTokenValue: string): Promise<AccountTokenInfo | null> {
		const row = OAuthAccounts.list('claude').find((account) => account.refreshToken === refreshTokenValue);

		return row ? this.refreshAccountToken(row.id, row.credentialVersion) : null;
	}

	// No-op — token state is DB-backed, no in-memory cache to clear
	static clearCachedToken(): void {}

	/** Legacy status of the active account only. */
	static getAuthStatus(): AuthStatus {
		const row = OAuthAccounts.active('claude');

		return { authenticated: !!row && !row.needsLogin, email: row?.email ?? undefined };
	}

	/** Legacy logout: removes only the active account (the next eligible one becomes active). */
	static logout(): void {
		const row = OAuthAccounts.active('claude');
		if (row) OAuthAccounts.remove('claude', row.id);
	}
}
