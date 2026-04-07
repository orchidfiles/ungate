import { openaiToAnthropic } from 'src/adapter/openai-to-anthropic';

import type { ModelMappingConfig } from '@ungate/shared';
import type { OpenAIChatRequest } from 'src/types/openai';

export class CompletionModelRouting {
	static isMiniMaxModel(model: string): boolean {
		const normalized = model.trim().toLowerCase();

		if (normalized.startsWith('minimax')) {
			return true;
		}

		if (normalized.startsWith('mini-max')) {
			return true;
		}

		return false;
	}

	static shouldRouteMiniMax(resolved: ModelMappingConfig | null, requestedModel: string): boolean {
		if (resolved?.provider === 'minimax') {
			return true;
		}

		return CompletionModelRouting.isMiniMaxModel(requestedModel);
	}

	static buildMiniMaxBody(openaiBody: OpenAIChatRequest, resolved: ModelMappingConfig | null): OpenAIChatRequest {
		if (resolved?.provider === 'minimax') {
			return { ...openaiBody, model: resolved.upstreamModel };
		}

		return openaiBody;
	}

	static isOpenAiMapped(resolved: ModelMappingConfig | null): resolved is ModelMappingConfig {
		if (!resolved) {
			return false;
		}

		if (String(resolved.provider) !== 'openai') {
			return false;
		}

		return true;
	}

	static buildOpenAiUpstreamBody(openaiBody: OpenAIChatRequest, resolved: ModelMappingConfig): OpenAIChatRequest {
		const withModel: OpenAIChatRequest = {
			...openaiBody,
			model: resolved.upstreamModel
		};

		if (resolved.reasoningBudget) {
			const withReasoning: OpenAIChatRequest = {
				...withModel,
				reasoning: { effort: resolved.reasoningBudget }
			};

			return withReasoning;
		}

		return withModel;
	}

	static toAnthropicRequest(
		openaiBody: OpenAIChatRequest,
		resolved: ModelMappingConfig | null
	): ReturnType<typeof openaiToAnthropic> {
		if (resolved?.provider === 'claude') {
			return openaiToAnthropic(openaiBody, {
				model: resolved.upstreamModel,
				reasoningBudget: resolved.reasoningBudget
			});
		}

		return openaiToAnthropic(openaiBody);
	}
}
