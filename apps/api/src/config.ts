import { MINIMAX_BASE_URLS, type AppSettings } from '@ungate/shared';

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
		beta: {
			oauth: 'oauth-2025-04-20',
			claudeCode: 'claude-code-20250219',
			interleavedThinking: 'interleaved-thinking-2025-05-14'
		}
	},
	minimax: {
		baseUrlGlobal: MINIMAX_BASE_URLS.global,
		baseUrlChina: MINIMAX_BASE_URLS.china
	},
	claudeCode: {
		systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude."
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
		codexUrl: 'https://chatgpt.com/backend-api/codex'
	}
} as const;

export type Config = ProxyConfig;

export function getConfig(settings: AppSettings): ProxyConfig {
	const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

	return {
		port: envPort ?? settings.port,
		apiKey: settings.apiKey ?? undefined,
		quietMode: settings.quiet
	};
}
