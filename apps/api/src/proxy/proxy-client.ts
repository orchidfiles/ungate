import { openaiToAnthropic } from '../adapter/openai-to-anthropic';

import { proxyRequest as proxyAnthropicRequest } from './anthropic-client';
import { proxyMiniMaxRequest } from './minimax-client';
import { proxyOpenAIRequest as proxyCodexRequest } from './openai-client';

import type { AIProviderName } from '../auth/base-provider';
import type { AnthropicRequest } from '../types';
import type { OpenAIChatRequest } from '../types/openai';
import type { ProxyResult, RequestContext } from '../types/proxy';

const MINIMAX_MODEL_PREFIXES = ['MiniMax'] as const;

function detectProvider(model: string): AIProviderName {
	const normalized = model.trim().toLowerCase();

	for (const prefix of MINIMAX_MODEL_PREFIXES) {
		if (normalized.startsWith(prefix.toLowerCase())) {
			return 'minimax';
		}
	}

	return 'claude';
}

export async function proxyRequest(
	endpoint: string,
	body: AnthropicRequest,
	headers: Record<string, string>
): Promise<ProxyResult> {
	return proxyAnthropicRequest(endpoint, body, headers);
}

export async function proxyOpenAIRequest(
	openaiBody: OpenAIChatRequest,
	provider?: AIProviderName
): Promise<{ response: Response; context: RequestContext }> {
	const resolved = provider ?? detectProvider(openaiBody.model);

	if (resolved === 'openai') {
		return proxyCodexRequest(openaiBody);
	}

	if (resolved === 'minimax') {
		return proxyMiniMaxRequest(openaiBody);
	}

	// Claude: convert OpenAI → Anthropic → proxy
	const anthropicBody = openaiToAnthropic(openaiBody);
	const anthropicHeaders: Record<string, string> = {};
	const result = await proxyAnthropicRequest('/v1/messages', anthropicBody, anthropicHeaders);

	return result;
}
