import { MINIMAX_BASE_URLS, type AppSettings } from '@ungate/shared';

import { CLAUDE_CODE_OPUS_PACKET } from './proxy/claude-code-packet';
import { logger } from './utils/logger';

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
		/** Antigravity installed-app OAuth requires a complete client pair from the environment. */
		clientVersion: '2.33.0',
		userAgent: `antigravity/hub/2.33.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=1023160026)`,
		oauth: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
			scope: [
				'https://www.googleapis.com/auth/cloud-platform',
				'https://www.googleapis.com/auth/userinfo.email',
				'https://www.googleapis.com/auth/userinfo.profile',
				'https://www.googleapis.com/auth/aicode',
				'https://www.googleapis.com/auth/cclog',
				'https://www.googleapis.com/auth/experimentsandconfigs'
			].join(' '),
			callbackPath: '/oauth2callback',
			successUrl: 'https://developers.google.com/gemini-code-assist/auth_success_gemini',
			failureUrl: 'https://developers.google.com/gemini-code-assist/auth_failure_gemini'
		},
		/** Consumer Antigravity endpoint. Never fall back to the enterprise Code Assist host. */
		codeAssistUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
	}
} as const;

export type Config = ProxyConfig;

export interface GeminiOAuthClientCredentials {
	clientId: string;
	clientSecret: string;
}

const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
let warnedInvalidGeminiClientId = false;

/**
 * Antigravity-compatible installed-app credentials come only from the environment.
 * Missing, partial or invalid pairs disable sign-in; no OAuth client is bundled.
 */
export function geminiOAuthClient(): GeminiOAuthClientCredentials | null {
	const clientId = process.env.UNGATE_GEMINI_OAUTH_CLIENT_ID?.trim();
	const clientSecret = process.env.UNGATE_GEMINI_OAUTH_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) return null;

	if (!clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
		if (!warnedInvalidGeminiClientId) {
			warnedInvalidGeminiClientId = true;
			logger.warn(`UNGATE_GEMINI_OAUTH_CLIENT_ID does not end with ${GOOGLE_CLIENT_ID_SUFFIX}; Gemini sign-in stays off`);
		}

		return null;
	}

	return { clientId, clientSecret };
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
