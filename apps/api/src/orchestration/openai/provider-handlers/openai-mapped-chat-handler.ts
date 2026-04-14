import { CompletionRequestTelemetry } from 'src/metrics';
import { CompletionErrorMapper, CompletionModelRouting, CompletionStreamingGateway } from 'src/orchestration/openai';
import { proxyOpenAIRequest } from 'src/proxy/proxy-client';

import type { ModelMappingConfig } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

export class OpenAiMappedChatHandler {
	static async handle(
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig,
		reply: FastifyReply
	): Promise<FastifyReply> {
		const upstreamBody = CompletionModelRouting.buildOpenAiUpstreamBody(openaiBody, resolvedModel);
		const { response, context } = await proxyOpenAIRequest(upstreamBody, 'openai');

		if (!response.ok) {
			const errorMessage = await CompletionErrorMapper.openAiUpstreamErrorMessage(response);
			const latencyMs = Date.now() - context.startTime;

			CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, latencyMs, {
				model: context.model,
				source: 'error',
				inputTokens: 0,
				outputTokens: 0,
				stream: false,
				latencyMs,
				error: errorMessage
			});

			return reply.code(response.status).send({ error: { message: errorMessage, type: 'api_error' } });
		}

		if (openaiBody.stream) {
			return CompletionStreamingGateway.sendOpenAiPassthroughStream(reply, response);
		}

		const responseJson = await response.json();
		const latencyMs = Date.now() - context.startTime;

		CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, latencyMs, {
			model: context.model,
			source: context.source,
			inputTokens: context.inputTokens ?? 0,
			outputTokens: context.outputTokens ?? 0,
			stream: false,
			latencyMs
		});

		return reply.send(responseJson);
	}
}
