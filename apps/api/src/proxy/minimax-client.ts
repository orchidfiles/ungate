import { logger } from 'src/utils/logger';

import { getProvider } from '../auth';
import { config } from '../config';
import { ProviderSettings } from '../database/settings';

import type { OpenAIChatRequest } from '../types/openai';

export async function proxyMiniMaxRequest(body: OpenAIChatRequest): Promise<{
	response: Response;
	context: {
		model: string;
		startTime: number;
		source: 'minimax';
		reverseToolMapping: Record<string, string>;
		inputTokens?: number;
		outputTokens?: number;
		bodyJson?: unknown;
	};
}> {
	const creds = ProviderSettings.get('minimax');
	const minimaxUrl = creds?.baseUrl ?? config.minimax.baseUrlGlobal;
	const provider = getProvider('minimax');
	const authHeader = await provider.getAuthHeader();

	if (!authHeader) {
		const noAuthResponse = new Response(
			JSON.stringify({ error: { message: 'No MiniMax API key configured', type: 'authentication_error' } }),
			{
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			}
		);

		return {
			response: noAuthResponse,
			context: {
				model: body.model,
				startTime: Date.now(),
				source: 'minimax',
				reverseToolMapping: {},
				bodyJson: { error: { message: 'No MiniMax API key configured', type: 'authentication_error' } }
			}
		};
	}

	const minimaxBody = {
		model: body.model,
		messages: body.messages,
		stream: body.stream ?? false,
		max_completion_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096,
		temperature: body.temperature,
		top_p: body.top_p,
		...(body.tools && body.tools.length > 0 && { tools: body.tools }),
		...(body.tool_choice && { tool_choice: body.tool_choice })
	};

	const startTime = Date.now();

	try {
		const response = await fetch(`${minimaxUrl}/v1/text/chatcompletion_v2`, {
			method: 'POST',
			headers: {
				Authorization: authHeader,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(minimaxBody)
		});

		logger.log(`✓ MiniMax request → ${response.status}`);

		let inputTokens: number | undefined;
		let outputTokens: number | undefined;

		if (!body.stream) {
			try {
				const rawJson = await response.json();
				const json = rawJson as {
					usage?: { input_tokens?: number; output_tokens?: number };
					error?: { message?: string; type?: string };
				};

				if (!response.ok) {
					return {
						response,
						context: {
							model: body.model,
							startTime,
							source: 'minimax' as const,
							reverseToolMapping: {},
							inputTokens: json.usage?.input_tokens,
							outputTokens: json.usage?.output_tokens,
							bodyJson: json
						}
					};
				}

				inputTokens = json.usage?.input_tokens;
				outputTokens = json.usage?.output_tokens;
			} catch {
				// response is not JSON (e.g. plain text error), continue without usage
			}
		}

		return {
			response,
			context: {
				model: body.model,
				startTime,
				source: 'minimax' as const,
				reverseToolMapping: {},
				inputTokens,
				outputTokens
			}
		};
	} catch (error) {
		logger.error(`MiniMax request failed: ${String(error)}`);

		return {
			response: new Response(JSON.stringify({ error: { message: String(error), type: 'api_error' } }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			}),
			context: {
				model: body.model,
				startTime,
				source: 'minimax' as const,
				reverseToolMapping: {},
				inputTokens: undefined,
				outputTokens: undefined
			}
		};
	}
}
