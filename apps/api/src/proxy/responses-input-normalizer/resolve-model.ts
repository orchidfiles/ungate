import type { CodexReasoningEffort, ResolvedChatGptModel } from './types';

export class ResponsesModelResolver {
	public static resolveModel(model: string): ResolvedChatGptModel {
		if (!model) {
			return { model: 'gpt-5.4' };
		}

		const effortLevels: CodexReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

		for (const effort of effortLevels) {
			if (model.endsWith(`-${effort}`)) {
				return { model: model.slice(0, -`-${effort}`.length), reasoningEffort: effort };
			}
		}

		if (model === 'gpt-5.4' || model === 'gpt-5.4-mini') {
			return { model };
		}

		if (model === 'gpt-5.3-codex') {
			return { model, reasoningEffort: 'medium' };
		}

		if (model === 'gpt-5.1-codex-mini') {
			return { model, reasoningEffort: 'medium' };
		}

		if (model.includes('codex')) {
			return { model };
		}

		if (model.startsWith('gpt-5.4')) {
			return { model: 'gpt-5.4' };
		}

		if (model.startsWith('gpt-5.3')) {
			return { model: 'gpt-5.3-codex', reasoningEffort: 'medium' };
		}

		if (model.startsWith('gpt-5.1')) {
			return { model: 'gpt-5.1-codex-mini', reasoningEffort: 'medium' };
		}

		return { model: 'gpt-5.4' };
	}
}
