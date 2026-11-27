import { CompletionRequestTelemetry } from 'src/metrics';
import { CompletionErrorMapper, CompletionStreamingGateway } from 'src/orchestration/openai';
import { GeminiClient } from 'src/proxy/gemini-client';
import { clientAbortSignal } from 'src/utils/request-abort';

import type { ModelMappingConfig, RequestTelemetry } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

export class GeminiChatHandler {
	static async handle(
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig,
		reply: FastifyReply,
		requestTelemetry: RequestTelemetry = {}
	): Promise<FastifyReply> {
		const { response, context } = await GeminiClient.proxy(openaiBody, resolvedModel, clientAbortSignal(reply));
		context.telemetry = { ...requestTelemetry, ...context.telemetry };

		if (!response.ok) {
			const error = await CompletionErrorMapper.openAiUpstreamErrorPayload(response);
			const latencyMs = Date.now() - context.startTime;

			CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, latencyMs, {
				stopReason: 'error',
				...context.telemetry,
				model: context.model,
				source: 'error',
				inputTokens: context.inputTokens ?? 0,
				outputTokens: context.outputTokens ?? 0,
				stream: !!openaiBody.stream,
				latencyMs,
				error: error.message
			});
			CompletionErrorMapper.applySafeRetryHeaders(reply, response);

			return reply.code(response.status).send({ error });
		}

		// The stream records its own terminal outcome when it ends.
		if (openaiBody.stream) return CompletionStreamingGateway.sendOpenAiPassthroughStream(reply, response);

		const responseJson = await response.json();
		const latencyMs = Date.now() - context.startTime;
		CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, latencyMs, {
			...context.telemetry,
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
