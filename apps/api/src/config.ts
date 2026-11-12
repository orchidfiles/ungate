import { MINIMAX_BASE_URLS, type AppSettings } from '@ungate/shared';

import { CLAUDE_CODE_OPUS_PACKET } from './proxy/claude-code-packet';

import type { ProxyConfig } from './types';

export const config = {
	claude: {
		clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
		oauth: {
			tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
			redirectUri: 'https://console.anthropic.com/oauth/code/callback'
		}
	},
	anthropic: {
		apiUrl: 'https://api.anthropic.com',
		/** Subscription usage (what Claude Code `/usage` shows). */
		usageUrl: 'https://api.anthropic.com/api/oauth/usage',
		usageBeta: 'oauth-2025-04-20',
		/** Subscription tier (`organization.rate_limit_tier`); same token and beta as usage. */
		profileUrl: 'https://api.anthropic.com/api/oauth/profile',
		betas: CLAUDE_CODE_OPUS_PACKET.betas
	},
	minimax: {
		baseUrlGlobal: MINIMAX_BASE_URLS.global,
		baseUrlChina: MINIMAX_BASE_URLS.china
	},
	claudeCode: {
		systemPrompt: CLAUDE_CODE_OPUS_PACKET.identity
	},
	openai: {
		oauth: {
			authorizeUrl: 'https://auth.openai.com/oauth/authorize',
			tokenUrl: 'https://auth.openai.com/oauth/token',
			redirectUri: 'http://localhost:1455/auth/callback',
			clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
			scope: 'openid profile email offline_access',
			codeChallengeMethod: 'S256',
			extraParams: {
				id_token_add_organizations: 'true',
				codex_cli_simplified_flow: 'true',
				originator: 'codex_cli_rs'
			}
		},
		codexUrl: 'https://chatgpt.com/backend-api/codex',
		/** Subscription usage (what Codex `/status` shows). */
		usageUrl: 'https://chatgpt.com/backend-api/wham/usage'
	},
	gemini: {
		/** The installed-app client comes from the environment; see `geminiOAuthClient()`. */
		oauth: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
			scope: [
				'https://www.googleapis.com/auth/cloud-platform',
				'https://www.googleapis.com/auth/userinfo.email',
				'https://www.googleapis.com/auth/userinfo.profile'
			].join(' '),
			callbackPath: '/oauth2callback',
			successUrl: 'https://developers.google.com/gemini-code-assist/auth_success_gemini',
			failureUrl: 'https://developers.google.com/gemini-code-assist/auth_failure_gemini'
		},
		/** Code Assist internal API (what gemini-cli talks to), not the paid Gemini API. */
		codeAssistUrl: 'https://cloudcode-pa.googleapis.com/v1internal'
	}
} as const;

export type Config = ProxyConfig;

export interface GeminiOAuthClientCredentials {
	clientId: string;
	clientSecret: string;
}

/**
 * Google OAuth installed-app client for Gemini sign-in, from `UNGATE_GEMINI_OAUTH_CLIENT_ID` and
 * `UNGATE_GEMINI_OAUTH_CLIENT_SECRET`. Ungate ships no client of its own; null when either is unset.
 */
export function geminiOAuthClient(): GeminiOAuthClientCredentials | null {
	const clientId = process.env.UNGATE_GEMINI_OAUTH_CLIENT_ID?.trim();
	const clientSecret = process.env.UNGATE_GEMINI_OAUTH_CLIENT_SECRET?.trim();

	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function getConfig(settings: AppSettings): ProxyConfig {
	let envPort: number | undefined;

	if (process.env.PORT) {
		const parsed = parseInt(process.env.PORT, 10);

		if (!Number.isNaN(parsed)) {
			envPort = parsed;
		}
	}

	return {
		port: envPort ?? settings.port,
		apiKey: settings.apiKey ?? undefined,
		quietMode: settings.quiet
	};
}
