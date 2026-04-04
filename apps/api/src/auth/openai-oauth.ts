import { randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { logger } from 'src/utils/logger';

import { config } from '../config';
import { ProviderSettings } from '../database/provider-settings';

import type { OAuthCredentials } from './base-provider';

interface CodexAuthInfo {
	chatgpt_account_id: string;
	chatgpt_plan_type: string;
	chatgpt_user_id: string;
	user_id: string;
	organizations: {
		id: string;
		is_default: boolean;
		role: string;
		title: string;
	}[];
}

interface PkceSession {
	codeVerifier: string;
	state: string;
	expiresAt: number;
}

export class OpenAIOAuth {
	private static readonly pkceStore = new Map<string, PkceSession>();
	private static callbackServer: Server | null = null;
	private static callbackServerTimeout: NodeJS.Timeout | null = null;

	static {
		setInterval(() => {
			const now = Date.now();
			for (const [sessionId, session] of this.pkceStore) {
				if (now >= session.expiresAt) {
					this.pkceStore.delete(sessionId);
				}
			}
		}, 60_000);
	}

	static async startLogin(): Promise<{ authUrl: string; sessionId: string }> {
		const { verifier, challenge } = await this.generatePkce();
		const sessionId = this.base64urlEncode(randomBytes(32));

		this.pkceStore.set(sessionId, {
			codeVerifier: verifier,
			state: verifier,
			expiresAt: Date.now() + 10 * 60 * 1000
		});

		const cfg = config.openai.oauth;
		const redirectUri = cfg.redirectUri;
		await this.startCallbackServer();

		const params = new URLSearchParams({
			response_type: 'code',
			client_id: cfg.clientId,
			redirect_uri: redirectUri,
			scope: cfg.scope,
			code_challenge: challenge,
			code_challenge_method: cfg.codeChallengeMethod,
			...cfg.extraParams,
			state: sessionId
		});

		return { authUrl: `${cfg.authorizeUrl}?${params}`, sessionId };
	}

	static async completeLogin(code: string, sessionId: string): Promise<{ ok: boolean; email?: string; error?: string }> {
		const session = this.pkceStore.get(sessionId);

		if (!session) {
			return { ok: false, error: 'Session not found or expired' };
		}

		if (Date.now() >= session.expiresAt) {
			this.pkceStore.delete(sessionId);

			return { ok: false, error: 'Session expired' };
		}

		this.pkceStore.delete(sessionId);

		const cfg = config.openai.oauth;
		const redirectUri = cfg.redirectUri;

		try {
			const response = await fetch(cfg.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: cfg.clientId,
					code,
					redirect_uri: redirectUri,
					code_verifier: session.codeVerifier
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token exchange failed:', response.status, errorText);

				return { ok: false, error: `Token exchange failed: ${response.status}` };
			}

			const json = await response.json();
			const tokens = json as Record<string, unknown>;
			const idToken = (tokens.id_token as string) || null;
			let email: string | null = null;
			let accountId: string | null = null;

			if (idToken) {
				const parsed = this.parseIdToken(idToken);
				email = parsed.email;
				accountId = this.resolveWorkspace(parsed.authInfo);
			}

			const expiresAt = Date.now() + ((tokens.expires_in as number) || 3600) * 1000;

			ProviderSettings.upsertOAuth('openai', {
				accessToken: tokens.access_token as string,
				refreshToken: (tokens.refresh_token as string) || '',
				expiresAt,
				email: email ?? undefined,
				accountId: accountId ?? undefined
			});

			logger.log('✓ OpenAI OAuth login complete', email ? `(${email})` : '');

			return { ok: true, email: email ?? undefined };
		} catch (error) {
			logger.error('completeLogin error:', error);

			return { ok: false, error: String(error) };
		}
	}

	static async getValidToken(): Promise<OAuthCredentials | null> {
		const creds = ProviderSettings.get('openai');

		if (!creds) return null;

		const bufferMs = 60_000;

		if (Date.now() < (creds.expiresAt ?? 0) - bufferMs) {
			return creds;
		}

		return this.refreshToken(creds.refreshToken ?? '');
	}

	static async refreshToken(refreshTokenValue: string): Promise<OAuthCredentials | null> {
		try {
			logger.log('Refreshing OpenAI token...');

			const cfg = config.openai.oauth;
			const response = await fetch(cfg.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: cfg.clientId,
					refresh_token: refreshTokenValue
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token refresh failed:', response.status, errorText);

				return null;
			}

			const json = await response.json();
			const tokens = json as Record<string, unknown>;
			const expiresAt = Date.now() + ((tokens.expires_in as number) || 3600) * 1000;

			const existing = ProviderSettings.get('openai');
			const credentials: OAuthCredentials = {
				accessToken: tokens.access_token as string,
				refreshToken: (tokens.refresh_token as string | null) ?? refreshTokenValue,
				expiresAt,
				email: existing?.email ?? undefined,
				accountId: existing?.accountId ?? undefined
			};

			ProviderSettings.upsertOAuth('openai', credentials);
			logger.log('OpenAI token refreshed successfully');

			return credentials;
		} catch (error) {
			logger.error('Failed to refresh token:', error);

			return null;
		}
	}

	static getAuthStatus(): { authenticated: boolean; email?: string } {
		const creds = ProviderSettings.get('openai');

		return { authenticated: !!creds?.accessToken, email: creds?.email ?? undefined };
	}

	static logout(): void {
		ProviderSettings.remove('openai');
		logger.log('✓ OpenAI OAuth logged out, tokens deleted');
	}

	private static async startCallbackServer(): Promise<void> {
		await this.stopCallbackServer();

		const callbackUrl = new URL(config.openai.oauth.redirectUri);
		const port = parseInt(callbackUrl.port, 10);
		const path = callbackUrl.pathname;

		const server = createServer((request, response) => {
			void this.handleCallbackRequest(request.url, path, response);
		});

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		});

		this.callbackServer = server;
		this.callbackServerTimeout = setTimeout(
			() => {
				void this.stopCallbackServer();
			},
			10 * 60 * 1000
		);
	}

	private static async stopCallbackServer(): Promise<void> {
		if (this.callbackServerTimeout) {
			clearTimeout(this.callbackServerTimeout);
			this.callbackServerTimeout = null;
		}

		if (!this.callbackServer) {
			return;
		}

		const server = this.callbackServer;
		this.callbackServer = null;

		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	}

	private static async handleCallbackRequest(
		requestUrl: string | undefined,
		path: string,
		response: ServerResponse
	): Promise<void> {
		if (!requestUrl) {
			response.statusCode = 400;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('<html><body><h1>Missing request URL</h1></body></html>');

			return;
		}

		const url = new URL(requestUrl, config.openai.oauth.redirectUri);

		if (url.pathname !== path) {
			response.statusCode = 404;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('<html><body><h1>Not found</h1></body></html>');

			return;
		}

		const code = url.searchParams.get('code');
		const sessionId = url.searchParams.get('state');

		if (!code || !sessionId) {
			response.statusCode = 400;
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end('<html><body><h1>Missing code or session</h1><p>Please close this window and try again.</p></body></html>');

			return;
		}

		const result = await this.completeLogin(code, sessionId);
		response.setHeader('Content-Type', 'text/html; charset=utf-8');

		if (result.ok) {
			response.end(
				'<html><body><h1>Connected!</h1><p>You can close this window.</p><script>window.close()</script></body></html>'
			);
		} else {
			response.statusCode = 400;
			response.end(`<html><body><h1>Error</h1><p>${result.error ?? 'Unknown error'}</p></body></html>`);
		}

		await this.stopCallbackServer();
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

	private static base64Decode(str: string): string {
		let base64 = str;

		switch (base64.length % 4) {
			case 2:
				base64 += '==';
				break;
			case 3:
				base64 += '=';
				break;
		}

		base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);

		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}

		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	}

	private static parseIdToken(idToken: string): { email: string | null; authInfo: CodexAuthInfo | null } {
		try {
			const parts = idToken.split('.');

			if (parts.length !== 3) {
				return { email: null, authInfo: null };
			}

			const decoded = JSON.parse(this.base64Decode(parts[1]));
			const email = (decoded as { email?: string }).email ?? null;
			const authInfo = (decoded as Record<string, CodexAuthInfo>)['https://api.openai.com/auth'] ?? null;

			return { email, authInfo };
		} catch {
			return { email: null, authInfo: null };
		}
	}

	private static resolveWorkspace(authInfo: CodexAuthInfo | null): string | null {
		if (!authInfo) return null;

		let workspaceId = authInfo.chatgpt_account_id || null;
		const planType = (authInfo.chatgpt_plan_type || '').toLowerCase();
		const organizations = authInfo.organizations || [];

		if (organizations.length > 0) {
			const teamOrg = organizations.find((org) => {
				const title = (org.title || '').toLowerCase();
				const role = (org.role || '').toLowerCase();

				return (
					!org.is_default &&
					(title.includes('team') ||
						title.includes('business') ||
						title.includes('workspace') ||
						title.includes('org') ||
						role === 'admin' ||
						role === 'member')
				);
			});

			if (planType.includes('team') || planType.includes('chatgptteam')) {
			} else if (teamOrg && (planType === 'free' || planType === '')) {
				workspaceId = teamOrg.id;
			}
		}

		return workspaceId;
	}
}
