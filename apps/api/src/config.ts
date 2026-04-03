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
