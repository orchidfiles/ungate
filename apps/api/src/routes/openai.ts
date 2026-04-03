import { logger } from 'src/utils/logger';

import { AnthropicToOpenai } from '../adapter/anthropic-to-openai';
import { openaiToAnthropic } from '../adapter/openai-to-anthropic';
import { Requests } from '../database/requests';
import { HeadersExtractor } from '../handlers/headers-extractor';
import { apiKeyAuth } from '../plugins/auth';
import { proxyRequest } from '../proxy/anthropic-client';
import { proxyMiniMaxRequest } from '../proxy/minimax-client';
import { MiniMaxStreamHandler } from '../streaming/minimax-stream-handler';
import { OpenAIStreamHandler } from '../streaming/openai-stream-handler';

import type { OpenAIChatRequest } from '../types/openai';
import type { FastifyPluginCallback } from 'fastify';

function isMiniMaxModel(model: string): boolean {
	return model.trim().toLowerCase().startsWith('minimax');
}

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/chat/completions', { preHandler: apiKeyAuth(config) }, async (request, reply) => {
		try {
			const openaiBody = request.body as OpenAIChatRequest;
			// logger.log(`[openai] body: ${JSON.stringify(request.body)}`);
			const minimaxRequest = isMiniMaxModel(openaiBody.model);

			if (minimaxRequest) {
				const { response, context } = await proxyMiniMaxRequest(openaiBody);

				if (!response.ok) {
					let errorMessage = 'Unknown error';

					if (context.bodyJson && typeof context.bodyJson === 'object') {
						const err = (context.bodyJson as { error?: { message?: string; type?: string } }).error;

						if (err?.message) {
							errorMessage = err.message;
						}
					} else {
						errorMessage = `HTTP ${response.status}`;
					}

					const errorLatencyMs = Date.now() - context.startTime;

					Requests.record({
						model: String(context.model ?? openaiBody.model),
						source: 'error',
						inputTokens: 0,
						outputTokens: 0,
						stream: false,
						latencyMs: errorLatencyMs,
						error: errorMessage
					});

					reply.header('x-request-id', `req_${Date.now()}`);
					reply.header('openai-processing-ms', errorLatencyMs.toString());
					reply.header('openai-version', '2020-10-01');

					return reply.code(response.status).send({
						error: { message: errorMessage, type: 'api_error' }
					});
				}

				if (openaiBody.stream) {
					for (const [key, value] of response.headers.entries()) {
						if (key.toLowerCase() !== 'content-encoding') {
							reply.header(key, value);
						}
					}

					reply.code(response.status);

					const { stream, headers: streamHeaders } = MiniMaxStreamHandler.createStreamResponse(
						response,
						Date.now().toString(),
						openaiBody.model,
						context
					);

					for (const [key, value] of Object.entries(streamHeaders)) {
						reply.header(key, value);
					}

					return reply.send(stream);
				}

				const responseJson = await response.json();
				const openaiResponse = context.bodyJson ?? responseJson;
				const latencyMs = Date.now() - context.startTime;

				Requests.record({
					model: String(context.model ?? openaiBody.model),
					source: context.source,
					inputTokens: context.inputTokens ?? 0,
					outputTokens: context.outputTokens ?? 0,
					stream: false,
					latencyMs
				});

				reply.header('x-request-id', `req_${Date.now()}`);
				reply.header('openai-processing-ms', latencyMs.toString());
				reply.header('openai-version', '2020-10-01');

				return reply.send(openaiResponse);
			}

			HeadersExtractor.logRequestDetails(request.headers, request.url, request.method, 'OpenAI /v1/chat/completions');
			const anthropicBody = openaiToAnthropic(openaiBody);
			const headers = HeadersExtractor.extractAnthropicHeaders(request.headers);
			const { response, context } = await proxyRequest('/v1/messages', anthropicBody, headers);

			if (!response.ok) {
				const errorJson = await response.json();
				const error = errorJson as { error?: { message?: string; type?: string } };
				let errorMessage = error?.error?.message ?? 'Unknown error';

				if (errorMessage.includes('model:')) {
					errorMessage = errorMessage.replace(/model:\s*x-([^\s,]+)/g, (_match, modelName) => `model: ${modelName}`);
				}

				const errorLatencyMs = Date.now() - context.startTime;

				Requests.record({
					model: context.model,
					source: context.source,
					inputTokens: 0,
					outputTokens: 0,
					stream: false,
					latencyMs: errorLatencyMs,
					error: errorMessage
				});

				reply.header('x-request-id', `req_${Date.now()}`);
				reply.header('openai-processing-ms', errorLatencyMs.toString());
				reply.header('openai-version', '2020-10-01');

				return reply.code(response.status).send({ error: { message: errorMessage, type: error?.error?.type } });
			}

			if (anthropicBody.stream) {
				const streamId = Date.now().toString();
				const { stream, headers: streamHeaders } = OpenAIStreamHandler.createStreamResponse(
					response,
					streamId,
					openaiBody.model,
					context
				);

				for (const [key, value] of Object.entries(streamHeaders)) {
					reply.header(key, value);
				}

				return reply.send(stream);
			}

			const anthropicResponse = await response.json();
			const openaiResponse = AnthropicToOpenai.convert(anthropicResponse, openaiBody.model);
			const latencyMs = Date.now() - context.startTime;

			Requests.record({
				model: context.model,
				source: context.source,
				inputTokens: context.inputTokens ?? 0,
				outputTokens: context.outputTokens ?? 0,
				stream: false,
				latencyMs
			});

			logger.log(
				`Recorded non-streaming request: ${context.model} | ${context.inputTokens ?? 0} in / ${context.outputTokens ?? 0} out`
			);

			reply.header('x-request-id', `req_${Date.now()}`);
			reply.header('openai-processing-ms', latencyMs.toString());
			reply.header('openai-version', '2020-10-01');

			return reply.send(openaiResponse);
		} catch (error) {
			logger.error(`OpenAI request handling error: ${String(error)}`);

			return reply.code(400).send({ error: { message: String(error), type: 'invalid_request_error' } });
		}
	});
};

export default plugin;
