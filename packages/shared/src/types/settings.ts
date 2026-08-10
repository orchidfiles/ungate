export type ReasoningBudgetTier = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelMappingProvider = 'claude' | 'minimax' | 'openai';
export type ModelServiceTier = 'default' | 'priority';

export const MODEL_MAPPING_PROVIDERS = ['claude', 'minimax', 'openai'] as const;
export const MODEL_SERVICE_TIERS = ['default', 'priority'] as const;
export const REASONING_BUDGET_TIERS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ModelMappingConfig {
	id: string;
	label: string;
	provider: ModelMappingProvider;
	upstreamModel: string;
	sortOrder: number;
	reasoningBudget: ReasoningBudgetTier | null;
	serviceTier: ModelServiceTier | null;
}

export interface AppSettings {
	port: number;
	apiKey: string | null;
	quiet: boolean;
	extraInstruction: string | null;
	models: ModelMappingConfig[];
}
