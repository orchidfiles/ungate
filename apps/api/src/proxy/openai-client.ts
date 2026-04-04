import { logger } from 'src/utils/logger';

import { config } from '../config';
import { Settings } from '../database/app-settings';
import { ProviderSettings } from '../database/provider-settings';

import { buildChatGptResponsesBody, resolveChatGptModel } from './responses-input-normalizer';
import { createResponsesStreamState, logResponsesStreamFinished, processResponsesChunk } from './responses-stream-mapper';

import type { OpenAIChatRequest } from '../types/openai';
import type { RequestContext } from '../types/proxy';

/** Codex `/responses` requires non-empty `instructions` (api_error otherwise). */
const CODEX_INSTRUCTIONS_FALLBACK =
	'You are a coding assistant integrated with the user editor. Follow the conversation and use tools when appropriate.';

const ENV_CHATGPT_INSTRUCTIONS = process.env.CHATGPT_INSTRUCTIONS?.trim();

export async function proxyOpenAIRequest(body: OpenAIChatRequest): Promise<{ response: Response; context: RequestContext }> {
	const startTime = Date.now();
	const model = body.model;
	const resolvedModel = resolveChatGptModel(model);
	const normalizedModel = resolvedModel.model;

	const creds = ProviderSettings.get('openai');
	if (!creds?.accessToken) {
		return {
			response: new Response(
				JSON.stringify({ error: { message: 'Not authenticated with OpenAI', type: 'authentication_error' } }),
				{
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				}
			),
			context: { model, source: 'error', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 }
		};
	}

	const accountId = creds.accountId;
	if (!accountId) {
		return {
			response: new Response(
				JSON.stringify({
					error: { message: 'ChatGPT account id missing. Re-login to refresh your ChatGPT token.', type: 'authentication_error' }
				}),
				{
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				}
			),
			context: { model, source: 'error', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 }
		};
	}

	const extraInstruction = Settings.get().extraInstruction;
	const buildResult = buildChatGptResponsesBody(body, model, {
		extraInstruction,
		envInstructions: ENV_CHATGPT_INSTRUCTIONS,
		instructionsFallback: CODEX_INSTRUCTIONS_FALLBACK
	});
	const requestBody = buildResult.payload;
	const incomingToolCount = Array.isArray(body.tools) ? body.tools.length : 0;

	logger.log(
		`[Codex] upstreamModel=${model} chatMessages=${buildResult.debug.chatMessages} inputField=${buildResult.debug.inputField} codexItems=${buildResult.debug.codexItems} fromBodyInput=${buildResult.debug.fromBodyInput}`
	);

	logger.log(`OpenAI Codex proxy: ${model} → ${normalizedModel} tools=${incomingToolCount} stream=${body.stream ?? false}`);

	const response = await fetch(`${config.openai.codexUrl}/responses`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${creds.accessToken}`,
			'chatgpt-account-id': accountId,
			originator: 'codex_cli_rs',
			accept: 'text/event-stream'
		},
		body: JSON.stringify(requestBody)
	});

	if (!response.ok) {
		const errorText = await response.text();
		logger.error('ChatGPT Codex upstream error:', response.status, errorText);

		let errorMessage = `ChatGPT API error (${response.status})`;

		try {
			const errBody = JSON.parse(errorText) as {
				error?: { message?: string };
				message?: string;
				detail?: string;
			};

			if (errBody.error?.message) {
				errorMessage = errBody.error.message;
			} else if (errBody.message) {
				errorMessage = errBody.message;
			} else if (errBody.detail) {
				errorMessage = errBody.detail;
			}
		} catch {
			if (errorText.trim()) {
				errorMessage = `${errorMessage}: ${errorText.slice(0, 500)}`;
			}
		}

		return {
			response: new Response(JSON.stringify({ error: { message: errorMessage, type: 'api_error' } }), {
				status: response.status,
				headers: { 'Content-Type': 'application/json' }
			}),
			context: { model, source: 'error', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 }
		};
	}

	const stream = body.stream ?? false;
	const state = createResponsesStreamState(normalizedModel);

	if (stream) {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		const streamBody = new ReadableStream({
			async start(controller) {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true });
					const results = processResponsesChunk(state, text);
					for (const result of results) {
						if (result.type === 'chunk') {
							controller.enqueue(`data: ${JSON.stringify(result.data)}\n\n`);
						} else if (result.type === 'done') {
							controller.enqueue('data: [DONE]\n\n');
						}
					}
				}
				reader.releaseLock();
				logResponsesStreamFinished(state, 'stream');
				controller.close();
			}
		});

		return {
			response: new Response(streamBody, {
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
			}),
			context: { model, source: 'openai', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 }
		};
	}

	// Non-streaming
	let fullContent = '';
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		const results = processResponsesChunk(state, text);

		for (const result of results) {
			const chunkData = result.data as
				| {
						choices?: {
							delta?: {
								content?: string | null;
							};
						}[];
				  }
				| undefined;

			if (result.type === 'chunk' && chunkData?.choices?.[0]?.delta) {
				const delta = chunkData.choices[0].delta;
				if (typeof delta.content === 'string') {
					fullContent += delta.content;
				}
			}
		}
	}
	reader.releaseLock();

	logResponsesStreamFinished(state, 'buffer');

	return {
		response: new Response(
			JSON.stringify({
				id: state.id,
				object: 'chat.completion',
				created: state.created,
				model: normalizedModel,
				choices: [{ index: 0, message: { role: 'assistant', content: fullContent || null }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			}
		),
		context: { model, source: 'openai', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 }
	};
}
