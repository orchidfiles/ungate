import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings, ProxyConfig } from './types';

export const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const CLAUDE_OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const ANTHROPIC_BETA_OAUTH = 'oauth-2025-04-20';
export const ANTHROPIC_BETA_CLAUDE_CODE = 'claude-code-20250219';
export const ANTHROPIC_BETA_INTERLEAVED_THINKING = 'interleaved-thinking-2025-05-14';

export const CLAUDE_CODE_BETA_HEADERS = [
	ANTHROPIC_BETA_CLAUDE_CODE,
	ANTHROPIC_BETA_OAUTH,
	ANTHROPIC_BETA_INTERLEAVED_THINKING
].join(',');

export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

export type Config = ProxyConfig;

export function getConfig(settings: AppSettings): ProxyConfig {
	return {
		port: settings.port,
		apiKey: settings.apiKey ?? undefined,
		quietMode: settings.quiet
	};
}
