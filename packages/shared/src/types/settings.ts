export type ClaudeReasoningBudget = 'low' | 'medium' | 'high';

export type ModelMappingProvider = 'claude' | 'minimax';

export interface ModelMappingConfig {
	id: string;
	label: string;
	provider: ModelMappingProvider;
	upstreamModel: string;
	enabled: boolean;
	sortOrder: number;
	reasoningBudget: ClaudeReasoningBudget | null;
}

export interface AppSettings {
	port: number;
	apiKey: string | null;
	quiet: boolean;
	extraInstruction: string | null;
	models: ModelMappingConfig[];
}
