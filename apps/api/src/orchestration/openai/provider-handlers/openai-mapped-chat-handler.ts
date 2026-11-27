import { CompletionRequestTelemetry } from 'src/metrics';
import { CompletionErrorMapper, CompletionModelRouting, CompletionStreamingGateway } from 'src/orchestration/openai';
import { proxyOpenAIRequest } from 'src/proxy/proxy-client';
import { clientAbortSignal } from 'src/utils/request-abort';

import type { ModelMappingConfig, RequestTelemetry } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

export class OpenAiMappedChatHandler {
	static async handle(
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig,
		reply: FastifyReply,
		requestTelemetry: RequestTelemetry = {}
	): Promise<FastifyReply> {
		const upstreamBody = CompletionModelRouting.buildOpenAiUpstreamBody(openaiBody, resolvedModel);
		const { response, context } = await proxyOpenAIRequest(upstreamBody, 'openai', clientAbortSignal(reply));
		context.telemetry = { ...requestTelemetry, ...context.telemetry };

		if (!response.ok) {
			const error = await CompletionErrorMapper.openAiUpstreamErrorPayload(response);
			const errorMessage = error.message;
			const latencyMs = Date.now() - context.startTime;

			CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, latencyMs, {
				stopReason: 'error',
				...context.telemetry,
				model: context.model,
				source: 'error',
				inputTokens: 0,
				outputTokens: 0,
				stream: false,
				latencyMs,
				error: errorMessage
			});

			CompletionErrorMapper.applySafeRetryHeaders(reply, response);

			return reply.code(response.status).send({ error });
		}

		if (openaiBody.stream) {
			const latencyMs = Date.now() - context.startTime;

			// The Codex stream records its own terminal outcome (success/failure) when it ends.
			if (!context.telemetryDeferred)
				CompletionRequestTelemetry.record({
					...context.telemetry,
					model: context.model,
					source: context.source,
					inputTokens: context.inputTokens ?? 0,
					outputTokens: context.outputTokens ?? 0,
					stream: true,
					latencyMs
				});

			return CompletionStreamingGateway.sendOpenAiPassthroughStream(reply, response);
		}

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
