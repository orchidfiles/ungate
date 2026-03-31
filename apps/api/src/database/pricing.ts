interface ModelPricing {
	inputPerMTok: number;
	outputPerMTok: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
	'claude-opus-4-6': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
	'claude-opus-4-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
	'claude-opus-4-1': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
	'claude-opus-4': { inputPerMTok: 15.0, outputPerMTok: 75.0 },

	'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
	'claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
	'claude-sonnet-4': { inputPerMTok: 3.0, outputPerMTok: 15.0 },

	'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },

	'claude-3-5-sonnet': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
	'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4.0 },

	'claude-3-opus': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
	'claude-3-sonnet': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
	'claude-3-haiku': { inputPerMTok: 0.25, outputPerMTok: 1.25 }
};

const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 3.0, outputPerMTok: 15.0 };

export class Pricing {
	// Matches by prefix to handle date suffixes, e.g. "claude-sonnet-4-20250514" → "claude-sonnet-4"
	static getModel(modelId: string): ModelPricing {
		if (MODEL_PRICING[modelId]) {
			return MODEL_PRICING[modelId];
		}

		for (const [pattern, pricing] of Object.entries(MODEL_PRICING)) {
			if (modelId.startsWith(pattern)) {
				return pricing;
			}
		}

		return DEFAULT_PRICING;
	}

	// Cache pricing: cache_read = 0.1x input, cache_creation = 1.25x input
	static calculateCost(
		modelId: string,
		inputTokens: number,
		outputTokens: number,
		cacheReadTokens = 0,
		cacheCreationTokens = 0
	): number {
		const pricing = this.getModel(modelId);

		const regularInputTokens = inputTokens - cacheReadTokens - cacheCreationTokens;
		const regularInputCost = (regularInputTokens / 1_000_000) * pricing.inputPerMTok;
		const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.inputPerMTok * 0.1;
		const cacheCreationCost = (cacheCreationTokens / 1_000_000) * pricing.inputPerMTok * 1.25;
		const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;

		return regularInputCost + cacheReadCost + cacheCreationCost + outputCost;
	}
}
