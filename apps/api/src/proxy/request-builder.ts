import { platform, arch } from 'node:os';

import { logger } from 'src/utils/logger';

import { config } from '../config';
import { Settings } from '../database/settings';

import type { AnthropicRequest, ContentBlock } from '../types';

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
			logger.warn(`Removed reasoning_budget (${budgetValue}) — not supported by Claude Code API`);
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
