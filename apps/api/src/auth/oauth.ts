import { randomBytes } from 'node:crypto';

import { minutesToMilliseconds } from 'date-fns';
import { desc } from 'drizzle-orm';

import { logger } from 'src/utils/logger';

import { CLAUDE_CLIENT_ID, ANTHROPIC_TOKEN_URL, CLAUDE_OAUTH_REDIRECT_URI } from '../config';
import { getDb } from '../database/index';
import { oauthTokens } from '../database/schema';

import type { TokenInfo, TokenRefreshResponse, AuthStatus, LoginStart } from '../types/index';

interface PkceSession {
	codeVerifier: string;
	expiresAt: number;
}

interface TokenExchangeResponse extends TokenRefreshResponse {
	account?: { uuid: string; email_address: string };
}

export class OAuth {
	private static readonly pkceStore = new Map<string, PkceSession>();
	private static readonly SESSION_TTL_MS = minutesToMilliseconds(15);

	static {
		setInterval(() => {
			const now = Date.now();

			for (const [sessionId, session] of this.pkceStore) {
				if (now >= session.expiresAt) {
					this.pkceStore.delete(sessionId);
				}
			}
		}, minutesToMilliseconds(1));
	}

	private static base64urlEncode(buf: Buffer): string {
		return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	}

	private static async generatePkce(): Promise<{ verifier: string; challenge: string }> {
		const verifier = this.base64urlEncode(randomBytes(32));
		const enc = new TextEncoder();
		const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
		const challenge = this.base64urlEncode(Buffer.from(digest));

		return { verifier, challenge };
	}

	static async startLogin(): Promise<LoginStart> {
		const { verifier, challenge } = await this.generatePkce();
		const sessionId = verifier;

		this.pkceStore.set(sessionId, {
			codeVerifier: verifier,
			expiresAt: Date.now() + this.SESSION_TTL_MS
		});

		const params = new URLSearchParams({
			code: 'true',
			response_type: 'code',
			client_id: CLAUDE_CLIENT_ID,
			redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
			scope: 'org:create_api_key user:profile user:inference',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state: verifier
		});

		const result: LoginStart = {
			authUrl: `https://claude.ai/oauth/authorize?${params}`,
			sessionId
		};

		return result;
	}

	static async completeLogin(codeInput: string, sessionId: string): Promise<{ ok: boolean; email?: string; error?: string }> {
		const session = this.pkceStore.get(sessionId);

		if (!session) {
			return { ok: false, error: 'Session not found or expired' };
		}

		if (Date.now() >= session.expiresAt) {
			this.pkceStore.delete(sessionId);

			return { ok: false, error: 'Session expired' };
		}

		this.pkceStore.delete(sessionId);

		// Input may be CODE#STATE — split to extract both
		const parts = codeInput.trim().split('#');
		const code = parts[0];
		const state = parts[1] ?? sessionId;

		try {
			const response = await fetch(ANTHROPIC_TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'authorization_code',
					client_id: CLAUDE_CLIENT_ID,
					redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
					code,
					state,
					code_verifier: session.codeVerifier
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token exchange failed:', response.status, errorText);

				return { ok: false, error: `Token exchange failed: ${response.status}` };
			}

			const data: TokenExchangeResponse = await response.json();
			const expiresAt = Date.now() + data.expires_in * 1000;
			const email = data.account?.email_address;

			const db = getDb();
			db.insert(oauthTokens)
				.values({
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
					expiresAt,
					email: email ?? null,
					createdAt: Date.now()
				})
				.run();

			logger.log('✓ OAuth login complete', email ? `(${email})` : '');

			return { ok: true, email };
		} catch (error) {
			logger.error('completeLogin error:', error);

			return { ok: false, error: String(error) };
		}
	}

	static isTokenExpired(expiresAt: number): boolean {
		const bufferMs = minutesToMilliseconds(5);

		return Date.now() >= expiresAt - bufferMs;
	}

	static async refreshToken(refreshTokenValue: string): Promise<TokenInfo | null> {
		try {
			logger.log('Refreshing OAuth token...');

			const response = await fetch(ANTHROPIC_TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: refreshTokenValue,
					client_id: CLAUDE_CLIENT_ID
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token refresh failed:', response.status, errorText);

				return null;
			}

			const data: TokenRefreshResponse = await response.json();
			const expiresAt = Date.now() + data.expires_in * 1000;

			const db = getDb();
			const prev = db.select().from(oauthTokens).orderBy(desc(oauthTokens.id)).limit(1).get();
			db.insert(oauthTokens)
				.values({
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
					expiresAt,
					email: prev?.email ?? null,
					createdAt: Date.now()
				})
				.run();

			logger.log('Token refreshed successfully');

			const result: TokenInfo = {
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				expiresAt,
				isExpired: false
			};

			return result;
		} catch (error) {
			logger.error('Failed to refresh token:', error);

			return null;
		}
	}

	static async getValidToken(): Promise<TokenInfo | null> {
		const db = getDb();
		const row = db.select().from(oauthTokens).orderBy(desc(oauthTokens.id)).limit(1).get();

		if (!row) {
			return null;
		}

		if (!this.isTokenExpired(row.expiresAt)) {
			const result: TokenInfo = {
				accessToken: row.accessToken,
				refreshToken: row.refreshToken,
				expiresAt: row.expiresAt,
				isExpired: false
			};

			return result;
		}

		return this.refreshToken(row.refreshToken);
	}

	// No-op — token state is DB-backed, no in-memory cache to clear
	static clearCachedToken(): void {}

	static getAuthStatus(): AuthStatus {
		const db = getDb();
		const row = db.select().from(oauthTokens).orderBy(desc(oauthTokens.id)).limit(1).get();

		if (!row) {
			return { authenticated: false };
		}

		return { authenticated: true, email: row.email ?? undefined };
	}

	static logout(): void {
		const db = getDb();
		db.delete(oauthTokens).run();
		logger.log('✓ Logged out, all OAuth tokens deleted');
	}
}
