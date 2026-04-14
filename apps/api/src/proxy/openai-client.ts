import { logger } from 'src/utils/logger';

import { config } from '../config';
import { Settings } from '../database/app-settings';
import { ProviderSettings } from '../database/provider-settings';

import { ResponsesBodyBuilder } from './responses-input-normalizer/build-body';
import { ResponsesModelResolver } from './responses-input-normalizer/resolve-model';
import { ResponsesSseProcessor, StreamDiagnostics, StreamStateFactory } from './responses-stream-mapper';

import type { OpenAIChatRequest } from '../types/openai';
import type { RequestContext } from '../types/proxy';

/** Codex `/responses` requires non-empty `instructions` (api_error otherwise). */
const CODEX_INSTRUCTIONS_FALLBACK =
	'You are a coding assistant integrated with the user editor. Follow the conversation and use tools when appropriate.';

const ENV_CHATGPT_INSTRUCTIONS = process.env.CHATGPT_INSTRUCTIONS?.trim();

interface ProxyOpenAiResult {
	response: Response;
	context: RequestContext;
}

export class OpenAiClient {
	static async proxy(body: OpenAIChatRequest): Promise<ProxyOpenAiResult> {
		const startTime = Date.now();
		const model = body.model;
		const resolvedModel = ResponsesModelResolver.resolveModel(model);
		const normalizedModel = resolvedModel.model;
		const creds = ProviderSettings.get('openai');

		if (!creds?.accessToken) {
			return this.authErrorResult(model, startTime, 'Not authenticated with OpenAI');
		}

		const accountId = creds.accountId;

		if (!accountId) {
			return this.authErrorResult(model, startTime, 'ChatGPT account id missing. Re-login to refresh your ChatGPT token.');
		}

		const response = await this.fetchCodexResponses(body, model, normalizedModel, creds.accessToken, accountId);

		if (!response.ok) {
			return this.upstreamErrorResult(response, model, startTime);
		}

		return this.successResult(body, response, model, normalizedModel, startTime);
	}

	private static authErrorResult(model: string, startTime: number, message: string): ProxyOpenAiResult {
		const errorResponse = new Response(JSON.stringify({ error: { message, type: 'authentication_error' } }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});

		return {
			response: errorResponse,
			context: this.errorContext(model, startTime)
		};
	}

	private static async fetchCodexResponses(
		body: OpenAIChatRequest,
		model: string,
		normalizedModel: string,
		accessToken: string,
		accountId: string
	): Promise<Response> {
		const rawExtraInstruction = Settings.get().extraInstruction;
		const extraInstruction = rawExtraInstruction ?? undefined;
		const buildResult = ResponsesBodyBuilder.buildBody(body, model, {
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

		return fetch(`${config.openai.codexUrl}/responses`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${accessToken}`,
				'chatgpt-account-id': accountId,
				originator: 'codex_cli_rs',
				accept: 'text/event-stream'
			},
			body: JSON.stringify(requestBody)
		});
	}

	private static async upstreamErrorResult(response: Response, model: string, startTime: number): Promise<ProxyOpenAiResult> {
		const errorText = await response.text();
		logger.error('ChatGPT Codex upstream error:', response.status, errorText);
		const errorMessage = this.parseUpstreamError(response.status, errorText);
		const errorResponse = new Response(JSON.stringify({ error: { message: errorMessage, type: 'api_error' } }), {
			status: response.status,
			headers: { 'Content-Type': 'application/json' }
		});

		return {
			response: errorResponse,
			context: this.errorContext(model, startTime)
		};
	}

	private static parseUpstreamError(status: number, errorText: string): string {
		let errorMessage = `ChatGPT API error (${status})`;

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

		return errorMessage;
	}

	private static async successResult(
		body: OpenAIChatRequest,
		response: Response,
		model: string,
		normalizedModel: string,
		startTime: number
	): Promise<ProxyOpenAiResult> {
		const stream = body.stream ?? false;
		const state = StreamStateFactory.create(normalizedModel);

		if (stream) {
			const streamResponse = this.streamResponse(response, state);

			return {
				response: streamResponse,
				context: this.openAiContext(model, startTime)
			};
		}

		const bufferedResponse = await this.bufferedResponse(response, state, normalizedModel);

		return {
			response: bufferedResponse,
			context: this.openAiContext(model, startTime)
		};
	}

	private static streamResponse(response: Response, state: ReturnType<typeof StreamStateFactory.create>): Response {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		const streamBody = new ReadableStream({
			async start(controller) {
				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						break;
					}

					const text = decoder.decode(value, { stream: true });
					const results = ResponsesSseProcessor.process(state, text);

					for (const result of results) {
						if (result.type === 'chunk') {
							controller.enqueue(`data: ${JSON.stringify(result.data)}\n\n`);
						} else if (result.type === 'done') {
							controller.enqueue('data: [DONE]\n\n');
						}
					}
				}

				reader.releaseLock();
				StreamDiagnostics.logFinished(state, 'stream');
				controller.close();
			}
		});

		return new Response(streamBody, {
			status: 200,
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
		});
	}

	private static async bufferedResponse(
		response: Response,
		state: ReturnType<typeof StreamStateFactory.create>,
		normalizedModel: string
	): Promise<Response> {
		let fullContent = '';
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			const text = decoder.decode(value, { stream: true });
			const results = ResponsesSseProcessor.process(state, text);

			for (const result of results) {
				if (result.type === 'chunk') {
					const chunkData = result.data as
						| {
								choices?: {
									delta?: {
										content?: string | null;
									};
								}[];
						  }
						| undefined;

					if (chunkData?.choices?.[0]?.delta) {
						const delta = chunkData.choices[0].delta;

						if (typeof delta.content === 'string') {
							fullContent += delta.content;
						}
					}
				}
			}
		}

		reader.releaseLock();
		StreamDiagnostics.logFinished(state, 'buffer');

		return new Response(
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
		);
	}

	private static errorContext(model: string, startTime: number): RequestContext {
		return { model, source: 'error', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 };
	}

	private static openAiContext(model: string, startTime: number): RequestContext {
		return { model, source: 'openai', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 };
	}
}
