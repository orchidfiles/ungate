import {
	CLAUDE_CLI_VERSION_MODES,
	CURSOR_TOOL_MODES,
	MODEL_MAPPING_PROVIDERS,
	MODEL_SERVICE_TIERS,
	REASONING_BUDGET_TIERS,
	type ClaudeCliVersionMode,
	type CursorToolMode,
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

export function isCursorToolMode(value: unknown): value is CursorToolMode {
	return typeof value === 'string' && CURSOR_TOOL_MODES.includes(value as CursorToolMode);
}

export function isClaudeCliVersionMode(value: unknown): value is ClaudeCliVersionMode {
	return typeof value === 'string' && CLAUDE_CLI_VERSION_MODES.includes(value as ClaudeCliVersionMode);
}
