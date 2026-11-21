import { platform, arch } from 'node:os';

import { ClaudeCliVersion } from '@ungate/shared';
import { logger } from 'src/utils/logger';

import { config } from '../config';
import { Settings } from '../database/app-settings';

import { CLAUDE_CODE_OPUS_PACKET } from './claude-code-packet';

import type { AnthropicRequest, ContentBlock, ThinkingEffort } from '../types';

/** Required on every request authenticated with a claude.ai OAuth token. */
const OAUTH_BETA = 'oauth-2025-04-20';

const VALID_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Opus 4.7, 4.8, and 5.5 reject manual budget_tokens (400). They use adaptive thinking,
// controlled by the `effort` parameter in a top-level `output_config` object.
// reasoning_budget is always a tier string ('low' | 'medium' | 'high' | 'xhigh')
// set from the model mapping; pass it through verbatim as the effort level.
function resolveEffort(budget: number | string | undefined): ThinkingEffort | null {
	if (typeof budget !== 'string') {
		return null;
	}

	const normalized = budget.toLowerCase();

	return (VALID_EFFORTS as readonly string[]).includes(normalized) ? (normalized as ThinkingEffort) : null;
}

export class RequestBuilder {
	private static getStainlessOS(): string {
		const p = platform();
		switch (p) {
			case 'darwin':
				return 'MacOS';
			case 'linux':
				return 'Linux';
			case 'win32':
				return 'Windows';
			default:
				return 'Unknown';
		}
	}

	private static getStainlessArch(): string {
		const a = arch();
		switch (a) {
			case 'arm64':
				return 'arm64';
			case 'x64':
				return 'x64';
			case 'arm':
				return 'arm';
			default:
				return 'unknown';
		}
	}

	static getStainlessHeaders(): Record<string, string> {
		return {
			'x-stainless-arch': this.getStainlessArch(),
			'x-stainless-lang': 'js',
			'x-stainless-os': this.getStainlessOS(),
			'x-stainless-package-version': '0.70.0',
			'x-stainless-retry-count': '0',
			'x-stainless-runtime': 'node',
			'x-stainless-runtime-version': process.version,
			'x-stainless-timeout': '600'
		};
	}

	static getClaudeOAuthUserAgent(): string {
		const { claudeCliVersionMode, claudeCliVersionCustom } = Settings.get();
		const version = ClaudeCliVersion.resolve(claudeCliVersionMode, claudeCliVersionCustom);

		return ClaudeCliVersion.formatUserAgent(version);
	}

	static getClaudeOAuthHeaders(accessToken: string): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			Authorization: `Bearer ${accessToken}`,
			'anthropic-beta': config.anthropic.betas.join(','),
			'anthropic-dangerous-direct-browser-access': 'true',
			'anthropic-version': '2023-06-01',
			'Content-Type': 'application/json',
			'User-Agent': this.getClaudeOAuthUserAgent(),
			'x-app': 'cli',
			...this.getStainlessHeaders()
		};

		return headers;
	}

	/**
	 * Upstream headers for a Claude Code caller: its own headers, the pool account's token, and the
	 * OAuth beta, which a CLI authenticating with an API key or auth token does not send.
	 */
	static claudeCodeCallerHeaders(callerHeaders: Record<string, string>, accessToken: string): Record<string, string> {
		const betas = (callerHeaders['anthropic-beta'] ?? '')
			.split(',')
			.map((beta) => beta.trim())
			.filter(Boolean);
		if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);

		return {
			...callerHeaders,
			'anthropic-version': callerHeaders['anthropic-version'] ?? '2023-06-01',
			'anthropic-beta': betas.join(','),
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`
		};
	}

	private static stripCacheTtl(content: ContentBlock[] | undefined): void {
		if (!Array.isArray(content)) return;

		for (const item of content) {
			if (item && typeof item === 'object' && 'cache_control' in item) {
				const cc = item.cache_control as Record<string, unknown>;

				if (cc && 'ttl' in cc) {
					delete cc.ttl;
				}
			}
		}
	}

	static prepareClaudeCodeBody(body: AnthropicRequest): AnthropicRequest {
		const prepared = { ...body };

		if ('reasoning_budget' in prepared) {
			const budgetValue = prepared.reasoning_budget;
			delete prepared.reasoning_budget;

			// Translate the tier into adaptive thinking + effort. Opus 4.7, 4.8, and 5.5 only
			// support this form; manual budget_tokens returns a 400. `effort` has no
			// effect without `thinking.type: "adaptive"`, so both must be set.
			const effort = resolveEffort(budgetValue);

			if (effort) {
				// Claude 5 models default to `display: "omitted"`, which streams empty thinking.
				// Claude Code asks for thinking updates, which Cursor shows while Claude thinks.
				prepared.thinking = {
					type: CLAUDE_CODE_OPUS_PACKET.thinking.type,
					display: CLAUDE_CODE_OPUS_PACKET.thinking.display
				};
				prepared.output_config = { ...prepared.output_config, effort };
				prepared.context_management = {
					edits: CLAUDE_CODE_OPUS_PACKET.contextManagement.edits.map((edit) => ({ type: edit.type, keep: edit.keep }))
				};
				logger.log(`Reasoning budget (${budgetValue}) → adaptive thinking (effort: ${effort})`);
			} else {
				logger.log(`Reasoning budget (${budgetValue}) ignored — no matching effort tier`);
			}
		}

		const systemPrompts: ContentBlock[] = [];

		if (config.claudeCode.systemPrompt) {
			systemPrompts.push({ type: 'text', text: config.claudeCode.systemPrompt });
		}

		const extraInstruction = Settings.get().extraInstruction;

		if (extraInstruction) {
			systemPrompts.push({ type: 'text', text: extraInstruction });
		}

		if (prepared.system) {
			if (typeof prepared.system === 'string') {
				systemPrompts.push({ type: 'text', text: prepared.system });
			} else if (Array.isArray(prepared.system)) {
				systemPrompts.push(...prepared.system);
			}
		}

		prepared.system = systemPrompts;

		if (Array.isArray(prepared.system)) {
			this.stripCacheTtl(prepared.system);
		}

		if (Array.isArray(prepared.messages)) {
			for (const message of prepared.messages) {
				if (Array.isArray(message.content)) {
					this.stripCacheTtl(message.content);
				}
			}
		}

		return prepared;
	}
}
