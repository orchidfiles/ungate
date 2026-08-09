export type ReasoningBudgetTier = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelMappingProvider = 'claude' | 'minimax' | 'openai';
export type ModelServiceTier = 'default' | 'priority';

// Cursor inlines images as base64 data URLs, so a handful of attachments can push a
// request past Fastify's 1 MiB default. Keep an explicit upper bound because Fastify
// parses the body before route authentication runs.
export const DEFAULT_BODY_LIMIT_MB = 64;
export const MIN_BODY_LIMIT_MB = 1;
export const MAX_BODY_LIMIT_MB = 64;

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
	bodyLimitMb: number;
	models: ModelMappingConfig[];
}
