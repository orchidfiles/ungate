import {
	MODEL_MAPPING_PROVIDERS,
	MODEL_SERVICE_TIERS,
	REASONING_BUDGET_TIERS,
	type ModelMappingProvider,
	type ModelServiceTier,
	type ReasoningBudgetTier
} from '../types/settings';

export function isModelMappingProvider(value: unknown): value is ModelMappingProvider {
	return typeof value === 'string' && MODEL_MAPPING_PROVIDERS.includes(value as ModelMappingProvider);
}

export function isReasoningBudgetTier(value: unknown): value is ReasoningBudgetTier {
	return typeof value === 'string' && REASONING_BUDGET_TIERS.includes(value as ReasoningBudgetTier);
}

export function isModelServiceTier(value: unknown): value is ModelServiceTier {
	return typeof value === 'string' && MODEL_SERVICE_TIERS.includes(value as ModelServiceTier);
}
