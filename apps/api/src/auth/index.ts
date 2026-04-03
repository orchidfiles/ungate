import { ClaudeProvider } from './claude-provider';
import { MiniMaxProvider } from './minimax-provider';

import type { AIProvider, AIProviderName } from './base-provider';

const providers: Record<string, AIProvider> = {
	claude: new ClaudeProvider(),
	minimax: new MiniMaxProvider()
};

export function getProvider(name: AIProviderName): AIProvider {
	return providers[name];
}
