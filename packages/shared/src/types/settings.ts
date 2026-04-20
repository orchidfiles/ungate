export type ReasoningBudgetTier = 'low' | 'medium' | 'high';

export type ModelMappingProvider = 'claude' | 'minimax' | 'openai';

export const MODEL_MAPPING_PROVIDERS = ['claude', 'minimax', 'openai'] as const;
export const REASONING_BUDGET_TIERS = ['low', 'medium', 'high'] as const;

export interface ModelMappingConfig {
	id: string;
	label: string;
	provider: ModelMappingProvider;
	upstreamModel: string;
	sortOrder: number;
	reasoningBudget: ReasoningBudgetTier | null;
}

export interface AppSettings {
	port: number;
	apiKey: string | null;
	quiet: boolean;
	extraInstruction: string | null;
	models: ModelMappingConfig[];
}
