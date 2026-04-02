import { logger } from 'src/utils/logger';

import { AnthropicToOpenai } from '../adapter/anthropic-to-openai';
import { Requests } from '../database/requests';
import { apiKeyAuth } from '../plugins/auth';
import { proxyOpenAIRequest } from '../proxy/proxy-client';
import { OpenAIStreamHandler } from '../streaming/openai-stream-handler';

import type { OpenAIChatRequest } from '../types/openai';
import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/chat/completions', { preHandler: apiKeyAuth(config) }, async (request, reply) => {
		try {
			const openaiBody = request.body as OpenAIChatRequest;

			const { response, context } = await proxyOpenAIRequest(openaiBody);

			if (!response.ok) {
				let errorMessage = 'Unknown error';

				if (context.bodyJson && typeof context.bodyJson === 'object') {
					const err = (context.bodyJson as { error?: { message?: string; type?: string } }).error;
					if (err?.message) {
						errorMessage = err.message;

						if (errorMessage.includes('model:')) {
							errorMessage = errorMessage.replace(/model:\s*x-([^\s,]+)/g, (_match, modelName) => `model: ${modelName}`);
						}
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

			// Non-streaming: convert to OpenAI format
			let openaiResponse;
			if (context.source === 'minimax') {
				// MiniMax returns OpenAI-compatible format already; body already parsed
				openaiResponse = context.bodyJson;
			} else {
				const anthropicResponse = await response.json();
				openaiResponse = AnthropicToOpenai.convert(anthropicResponse, openaiBody.model);
			}

			const latencyMs = Date.now() - context.startTime;

			Requests.record({
				model: String(context.model ?? openaiBody.model),
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
