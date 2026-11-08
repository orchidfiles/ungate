import { detectProviderByModel } from '@ungate/shared';

import { openaiToAnthropic } from '../adapter/openai-to-anthropic';

import { proxyRequest as proxyAnthropicRequest } from './anthropic-client';
import { proxyMiniMaxRequest } from './minimax-client';
import { OpenAiClient } from './openai-client';

import type { AIProviderName } from '../auth/base-provider';
import type { AnthropicRequest } from '../types';
import type { OpenAIChatRequest } from '../types/openai';
import type { ProxyResult, RequestContext } from '../types/proxy';

function detectProvider(model: string): AIProviderName {
	// Cursor is reachable only through explicit mappings, never by model-name detection.
	const detected = detectProviderByModel(model);

	return detected === 'cursor' ? 'claude' : detected;
}

export async function proxyRequest(
	endpoint: string,
	body: AnthropicRequest,
	headers: Record<string, string>,
	signal?: AbortSignal
): Promise<ProxyResult> {
	return proxyAnthropicRequest(endpoint, body, headers, signal);
}

export async function proxyOpenAIRequest(
	openaiBody: OpenAIChatRequest,
	provider?: AIProviderName,
	signal?: AbortSignal
): Promise<{ response: Response; context: RequestContext }> {
	const resolved = provider ?? detectProvider(openaiBody.model);

	if (resolved === 'openai') {
		return OpenAiClient.proxy(openaiBody, signal);
	}

	if (resolved === 'minimax') {
		return proxyMiniMaxRequest(openaiBody);
	}

	// Claude: convert OpenAI → Anthropic → proxy
	const anthropicBody = openaiToAnthropic(openaiBody);
	const anthropicHeaders: Record<string, string> = {};
	const result = await proxyAnthropicRequest('/v1/messages', anthropicBody, anthropicHeaders, signal);

	return result;
}
