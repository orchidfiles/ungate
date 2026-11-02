import { logger } from 'src/utils/logger';

import { OAuth } from '../auth/oauth';
import { config } from '../config';

import { AccountFallback } from './account-fallback';
import { RequestBuilder } from './request-builder';
import { SsePrecommitGate } from './sse-precommit-gate';
import { ToolMapper } from './tool-mapper';

import type { RequestSource, AnthropicRequest, AnthropicError, ContentBlock, Tool } from '../types';
import type { ProxyResult, ToolUseBlock } from '../types/proxy';

type AccountTokenInfo = NonNullable<Awaited<ReturnType<typeof OAuth.getValidToken>>>;

type RequestResult =
	| {
			success: true;
			response: Response;
			source: RequestSource;
			reverseToolMapping: Record<string, string>;
			onStreamError: (error: Record<string, unknown> | undefined) => void;
	  }
	| { success: false; error: string; status: number; errorType?: string; headers?: Record<string, string> };

interface UpstreamErrorDetail {
	message: string;
	type: string;
}

/** Reads an upstream Anthropic error body once; keeps its message/type for downstream mapping. */
async function readUpstreamError(response: Response): Promise<UpstreamErrorDetail> {
	const text = await response.text().catch(() => '');
	try {
		const json = JSON.parse(text) as { error?: { message?: unknown; type?: unknown } };

		return {
			message: typeof json.error?.message === 'string' ? json.error.message : '',
			type: typeof json.error?.type === 'string' ? json.error.type : ''
		};
	} catch {
		return { message: text.trim().slice(0, 500), type: '' };
	}
}

function logInvalidArguments(preparedBody: AnthropicRequest, errorMessage: string, errorType: string): void {
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

/** One attempt pinned to `token`'s account, with the same-account 401 refresh retry. */
async function sendPinned(
	url: string,
	payload: string,
	token: AccountTokenInfo,
	signal?: AbortSignal
): Promise<{ response: Response; credentials: AccountTokenInfo }> {
	const response = await fetch(url, {
		signal,
		method: 'POST',
		headers: RequestBuilder.getClaudeOAuthHeaders(token.accessToken),
		body: payload
	});

	if (response.status !== 401 || !token.localAccountId) return { response, credentials: token };

	const errorBody = await response.text().catch(() => '');
	logger.error(`Claude Code 401 error: ${errorBody}`);
	// Pinned to the account (and credential generation) this request used — never the current selection.
	logger.log(`Attempting token refresh after 401 (account ${token.localAccountId})...`);
	const refreshed = await OAuth.refreshAccountToken(token.localAccountId, token.credentialVersion);

	if (!refreshed) {
		return {
			response: new Response(errorBody, { status: 401, headers: { 'content-type': 'application/json' } }),
			credentials: token
		};
	}

	const retryResponse = await fetch(url, {
		signal,
		method: 'POST',
		headers: RequestBuilder.getClaudeOAuthHeaders(refreshed.accessToken),
		body: payload
	});
	logger.log(`Retry after refresh: ${retryResponse.status}`);

	return { response: retryResponse, credentials: refreshed };
}

async function makeClaudeCodeRequest(
	endpoint: string,
	body: AnthropicRequest,
	_headers: Record<string, string>,
	signal?: AbortSignal
): Promise<RequestResult> {
	try {
		const preparedBody = RequestBuilder.prepareClaudeCodeBody(body);

		let reverseToolMapping: Record<string, string> = {};
		if (preparedBody.tools && preparedBody.tools.length > 0) {
			const mapped = ToolMapper.map(preparedBody.tools);
			preparedBody.tools = mapped.tools;
			reverseToolMapping = mapped.reverseMapping;
		}

		const url = `${config.anthropic.apiUrl}${endpoint}?beta=true`;
		const payload = JSON.stringify(preparedBody);

		const outcome = await AccountFallback.run<AccountTokenInfo>({
			provider: 'claude',
			getCredentials: (accountId) => OAuth.getValidToken(accountId),
			send: (token) => sendPinned(url, payload, token, signal),
			// Streams: explicit early SSE usage-limit errors rotate before anything is committed.
			inspect: SsePrecommitGate.inspector('claude', { signal }),
			signal
		});

		if (outcome.kind === 'no_credentials') {
			return { success: false, error: 'No valid OAuth token', status: 401 };
		}

		if (outcome.kind === 'limited') {
			logger.log(`Claude Code usage limit: no eligible account (${outcome.reason})`);

			return { success: false, error: outcome.message, status: 429, errorType: 'rate_limit_error', headers: outcome.headers };
		}

		const { response } = outcome;

		if (response.status === 429) {
			// Ordinary throttling (not a subscription usage limit): no rotation, keep upstream detail.
			const detail = await readUpstreamError(response);
			logger.log(`Claude Code rate limited: ${detail.message || 'no detail'}`);

			return {
				success: false,
				error: detail.message || 'Rate limited',
				status: 429,
				errorType: detail.type || 'rate_limit_error',
				headers: AccountFallback.safeRetryHeaders(response.headers)
			};
		}

		if (response.status === 401) {
			const detail = await readUpstreamError(response);

			return {
				success: false,
				error: detail.message ? `OAuth token invalid: ${detail.message}` : 'OAuth token invalid',
				status: 401,
				errorType: 'authentication_error'
			};
		}

		if (response.status === 403) {
			const detail = await readUpstreamError(response);
			logger.error(`Claude Code 403 error: ${detail.message}`);

			return {
				success: false,
				error: detail.message ? `Permission denied: ${detail.message}` : 'Permission denied',
				status: 403,
				errorType: detail.type || 'permission_error'
			};
		}

		if (response.status === 400) {
			const { message: errorMessage, type: errorType } = await readUpstreamError(response);

			logger.error(`API 400 Error: ${errorMessage} (type: ${errorType})`);

			if (errorMessage.includes('illegal value') || errorMessage.includes('invalid') || errorMessage.includes('argument')) {
				logInvalidArguments(preparedBody, errorMessage, errorType);
			}

			if (errorMessage.includes('only authorized for use with Claude Code')) {
				return { success: false, error: 'OAuth not authorized for API', status: 403, errorType: 'permission_error' };
			}

			return { success: false, error: errorMessage || 'Bad request', status: 400, errorType: errorType || undefined };
		}

		const onStreamError = SsePrecommitGate.cooldownOnStreamLimit(
			'claude',
			outcome.accountId,
			outcome.credentials.credentialVersion,
			response.headers
		);

		return { success: true, response, source: 'claude', reverseToolMapping, onStreamError };
	} catch (error) {
		if (signal?.aborted) {
			logger.log('Claude Code request aborted by client; fallback stopped');

			return { success: false, error: 'Client closed request', status: 499, errorType: 'client_closed_request' };
		}
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
	headers: Record<string, string>,
	signal?: AbortSignal
): Promise<ProxyResult> {
	const startTime = Date.now();
	const model = body.model;
	const stream = body.stream ?? false;

	const claudeResult = await makeClaudeCodeRequest(endpoint, body, headers, signal);

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
				outputTokens,
				onStreamError: claudeResult.onStreamError
			}
		};
	}

	const errorResponse: AnthropicError = {
		type: 'error',
		error: { type: claudeResult.errorType ?? 'api_error', message: claudeResult.error }
	};

	return {
		response: new Response(JSON.stringify(errorResponse), {
			status: claudeResult.status,
			headers: { ...claudeResult.headers, 'Content-Type': 'application/json' }
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
