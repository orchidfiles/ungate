import type { ModelMappingProvider } from '../types';

export const PROVIDER_LABELS: Record<ModelMappingProvider, string> = {
	claude: 'Claude',
	openai: 'OpenAI',
	minimax: 'MiniMax'
};

export function getProviderLabel(provider: ModelMappingProvider): string {
	return PROVIDER_LABELS[provider];
}
