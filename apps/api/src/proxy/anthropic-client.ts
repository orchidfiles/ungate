import { logger } from 'src/utils/logger';

import { OAuth } from '../auth/oauth';
import { ANTHROPIC_API_URL, CLAUDE_CODE_BETA_HEADERS } from '../config';
import { type RequestSource, type AnthropicRequest, type AnthropicError, type ContentBlock, type Tool } from '../types';

import { RequestBuilder } from './request-builder';
import { ToolMapper } from './tool-mapper';

import type { ProxyResult, ToolUseBlock } from '../types/proxy';

type RequestResult =
	| { success: true; response: Response; source: RequestSource; reverseToolMapping: Record<string, string> }
	| { success: false; error: string; status: number };

async function makeClaudeCodeRequest(
	endpoint: string,
	body: AnthropicRequest,
	_headers: Record<string, string>
): Promise<RequestResult> {
	const token = await OAuth.getValidToken();

	if (!token) {
		return { success: false, error: 'No valid OAuth token', status: 401 };
	}

	try {
		const preparedBody = RequestBuilder.prepareClaudeCodeBody(body);

		if ('reasoning_budget' in preparedBody) {
			delete preparedBody.reasoning_budget;
		}

		let reverseToolMapping: Record<string, string> = {};
		if (preparedBody.tools && preparedBody.tools.length > 0) {
			const mapped = ToolMapper.map(preparedBody.tools);
			preparedBody.tools = mapped.tools;
			reverseToolMapping = mapped.reverseMapping;
		}

		const url = `${ANTHROPIC_API_URL}${endpoint}?beta=true`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${token.accessToken}`,
				'anthropic-beta': CLAUDE_CODE_BETA_HEADERS,
				'anthropic-dangerous-direct-browser-access': 'true',
				'anthropic-version': '2023-06-01',
				'Content-Type': 'application/json',
				'User-Agent': 'claude-cli/2.1.9 (external, claude-vscode, agent-sdk/0.2.7)',
				'x-app': 'cli',
				...RequestBuilder.getStainlessHeaders()
			},
			body: JSON.stringify(preparedBody)
		});

		if (response.status === 429) {
			logger.log('Claude Code rate limited');

			return { success: false, error: 'Rate limited', status: 429 };
		}

		if (response.status === 401) {
			logger.log('OAuth token expired or invalid, clearing cache');
			OAuth.clearCachedToken();

			return { success: false, error: 'OAuth token invalid', status: 401 };
		}

		if (response.status === 403) {
			const errorBody = await response.clone().text();
			logger.error(`Claude Code 403 error: ${errorBody}`);

			return { success: false, error: 'Permission denied', status: 403 };
		}

		if (response.status === 400) {
			const errorJson = await response
				.clone()
				.json()
				.catch(() => ({}));
			const errorBody = errorJson as { error?: { message?: string; type?: string } };
			const errorMessage = errorBody?.error?.message ?? '';
			const errorType = errorBody?.error?.type ?? '';

			logger.error(`API 400 Error: ${errorMessage} (type: ${errorType})`);

			if (errorMessage.includes('illegal value') || errorMessage.includes('invalid') || errorMessage.includes('argument')) {
				const toolSchemas =
					preparedBody.tools?.map((tool: Tool) => ({
						name: tool.name,
						description: tool.description.substring(0, 200),
						input_schema: tool.input_schema
					})) ?? [];

				let toolUseBlocks: ToolUseBlock[] = [];
				if (preparedBody.messages && preparedBody.messages.length > 0) {
					const lastMsg = preparedBody.messages[preparedBody.messages.length - 1];
					if (Array.isArray(lastMsg.content)) {
						toolUseBlocks = lastMsg.content
							.filter((b: ContentBlock) => b.type === 'tool_use')
							.map((b: ContentBlock) => ({
								type: 'tool_use' as const,
								name: b.name ?? '',
								id: b.id ?? '',
								input: b.input as Record<string, unknown>
							}));
					}
				}

				logger.rareError(errorMessage, {
					errorType,
					requestBody: {
						model: preparedBody.model,
						messagesCount: preparedBody.messages?.length ?? 0,
						toolsCount: preparedBody.tools?.length ?? 0,
						stream: preparedBody.stream
					},
					toolSchemas,
					toolUseBlocks,
					fullRequestPreview: JSON.stringify(preparedBody, null, 2).substring(0, 3000)
				});
			}

			if (errorMessage.includes('only authorized for use with Claude Code')) {
				return { success: false, error: 'OAuth not authorized for API', status: 403 };
			}

			return { success: false, error: errorMessage || 'Bad request', status: 400 };
		}

		return { success: true, response, source: 'claude_code', reverseToolMapping };
	} catch (error) {
		logger.error(`Claude Code OAuth request failed: ${String(error)}`);

		return { success: false, error: String(error), status: 500 };
	}
}

async function extractUsage(response: Response, stream: boolean): Promise<{ inputTokens: number; outputTokens: number }> {
	if (stream) {
		return { inputTokens: 0, outputTokens: 0 };
	}

	try {
		const json = await response.clone().json();
		const data = json as { usage?: { input_tokens?: number; output_tokens?: number } };
		const usage = data.usage ?? {};

		return {
			inputTokens: usage.input_tokens ?? 0,
			outputTokens: usage.output_tokens ?? 0
		};
	} catch {
		return { inputTokens: 0, outputTokens: 0 };
	}
}

export async function proxyRequest(
	endpoint: string,
	body: AnthropicRequest,
	headers: Record<string, string>
): Promise<ProxyResult> {
	const startTime = Date.now();
	const model = body.model;
	const stream = body.stream ?? false;

	const claudeResult = await makeClaudeCodeRequest(endpoint, body, headers);

	if (claudeResult.success) {
		logger.log('✓ Request served via Claude Code');

		const { inputTokens, outputTokens } = await extractUsage(claudeResult.response, stream);

		return {
			response: claudeResult.response,
			context: {
				model,
				source: claudeResult.source,
				startTime,
				reverseToolMapping: claudeResult.reverseToolMapping,
				inputTokens,
				outputTokens
			}
		};
	}

	const errorResponse: AnthropicError = {
		type: 'error',
		error: { type: 'api_error', message: claudeResult.error }
	};

	return {
		response: new Response(JSON.stringify(errorResponse), {
			status: claudeResult.status,
			headers: { 'Content-Type': 'application/json' }
		}),
		context: {
			model,
			source: 'error',
			startTime,
			reverseToolMapping: {},
			inputTokens: 0,
			outputTokens: 0
		}
	};
}
