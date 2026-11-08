export type ReasoningBudgetTier = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelMappingProvider = 'claude' | 'minimax' | 'openai' | 'cursor';
export type ModelServiceTier = 'default' | 'priority';
/** How tool schemas are sent to Cursor-hosted models; `auto` picks per model. */
export type CursorToolMode = 'auto' | 'structured' | 'embedded';

export const MODEL_MAPPING_PROVIDERS = ['claude', 'minimax', 'openai', 'cursor'] as const;
export const CURSOR_TOOL_MODES = ['auto', 'structured', 'embedded'] as const;
export const MODEL_SERVICE_TIERS = ['default', 'priority'] as const;
export const REASONING_BUDGET_TIERS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const CLAUDE_CLI_VERSION_MODES = ['stable', 'latest', 'custom'] as const;

export type ClaudeCliVersionMode = (typeof CLAUDE_CLI_VERSION_MODES)[number];

export interface ModelMappingConfig {
	id: string;
	label: string;
	provider: ModelMappingProvider;
	upstreamModel: string;
	sortOrder: number;
	reasoningBudget: ReasoningBudgetTier | null;
	serviceTier: ModelServiceTier | null;
	/** Cursor provider only; null means `auto`. */
	toolMode?: CursorToolMode | null;
}

export interface AppSettings {
	port: number;
	apiKey: string | null;
	quiet: boolean;
	extraInstruction: string | null;
	claudeCliVersionMode: ClaudeCliVersionMode;
	claudeCliVersionCustom: string | null;
	models: ModelMappingConfig[];
}
