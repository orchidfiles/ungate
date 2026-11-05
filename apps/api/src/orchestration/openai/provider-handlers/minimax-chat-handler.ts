import { CompletionRequestTelemetry } from 'src/metrics';
import { CompletionErrorMapper, CompletionModelRouting, CompletionStreamingGateway } from 'src/orchestration/openai';
import { proxyMiniMaxRequest } from 'src/proxy/minimax-client';

import type { ModelMappingConfig, RequestTelemetry } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

export class MiniMaxChatHandler {
	static async handle(
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig | null,
		reply: FastifyReply,
		requestTelemetry: RequestTelemetry = {}
	): Promise<FastifyReply> {
		const minimaxBody = CompletionModelRouting.buildMiniMaxBody(openaiBody, resolvedModel);
		const { response, context } = await proxyMiniMaxRequest(minimaxBody);
		context.telemetry = { ...requestTelemetry, ...context.telemetry };

		if (!response.ok) {
			const errorMessage = CompletionErrorMapper.miniMaxErrorMessage(response, context);
			const errorLatencyMs = Date.now() - context.startTime;

			CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, errorLatencyMs, {
				...context.telemetry,
				stopReason: 'error',
				model: String(context.model ?? minimaxBody.model),
				source: 'error',
				inputTokens: 0,
				outputTokens: 0,
				stream: false,
				latencyMs: errorLatencyMs,
				error: errorMessage
			});

			return reply.code(response.status).send({
				error: { message: errorMessage, type: 'api_error' }
			});
		}

		if (minimaxBody.stream) {
			return CompletionStreamingGateway.sendMiniMaxStream(reply, response, minimaxBody.model, context);
		}

		const responseJson = await response.json();
		const openaiResponse = context.bodyJson ?? responseJson;
		const latencyMs = Date.now() - context.startTime;

		CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, latencyMs, {
			...context.telemetry,
			model: String(context.model ?? minimaxBody.model),
			source: context.source,
			inputTokens: context.inputTokens ?? 0,
			outputTokens: context.outputTokens ?? 0,
			stream: false,
			latencyMs
		});

		return reply.send(openaiResponse);
	}
}
