import { ClaudeProvider } from './claude-provider';
import { MiniMaxProvider } from './minimax-provider';
import { OpenAIProvider } from './openai-provider';

import type { AIProvider, AIProviderName } from './base-provider';

const providers: Record<string, AIProvider> = {
	claude: new ClaudeProvider(),
	minimax: new MiniMaxProvider(),
	openai: new OpenAIProvider()
};

export function getProvider(name: AIProviderName): AIProvider {
	return providers[name];
}
