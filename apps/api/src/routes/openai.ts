import { ModelMappings } from 'src/database/model-mappings';
import { Requests } from 'src/database/requests';
import { RequestHeuristics } from 'src/metrics';
import { CompletionModelRouting } from 'src/orchestration/openai';
import {
	ClaudeChatHandler,
	CursorChatHandler,
	MiniMaxChatHandler,
	OpenAiMappedChatHandler
} from 'src/orchestration/openai/provider-handlers';
import { apiKeyAuth } from 'src/plugins/auth';
import { logger } from 'src/utils/logger';

import type { RequestTelemetry } from '@ungate/shared';
import type { FastifyPluginCallback } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

function requestTelemetry(body: OpenAIChatRequest, reasoningTier: string | null | undefined): RequestTelemetry {
	try {
		return RequestHeuristics.compute({
			body,
			reasoningTier,
			previousStopReason: (sessionKey) => Requests.lastStopReasonForSession(sessionKey)
		});
	} catch (error) {
		// Telemetry must never block a completion.
		logger.error(`Request heuristics failed: ${String(error)}`);

		return {};
	}
}

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/chat/completions', { onRequest: apiKeyAuth(config) }, async (request, reply) => {
		try {
			const openaiBody = request.body as OpenAIChatRequest;
			const resolvedModel = ModelMappings.resolveForChatCompletion(openaiBody.model);
			const telemetry = requestTelemetry(openaiBody, resolvedModel?.reasoningBudget);

			// Branch order matters: MiniMax (mapping or name prefix) -> DB-mapped OpenAI -> DB-mapped Cursor -> default Claude.
			// A Cursor mapping never falls through to Claude.
			if (CompletionModelRouting.shouldRouteMiniMax(resolvedModel, openaiBody.model)) {
				return MiniMaxChatHandler.handle(openaiBody, resolvedModel, reply, telemetry);
			}

			if (CompletionModelRouting.isOpenAiMapped(resolvedModel)) {
				return OpenAiMappedChatHandler.handle(openaiBody, resolvedModel, reply, telemetry);
			}

			if (CompletionModelRouting.isCursorMapped(resolvedModel)) {
				return CursorChatHandler.handle(openaiBody, resolvedModel, reply, telemetry);
			}

			return ClaudeChatHandler.handle(request, openaiBody, resolvedModel, reply, telemetry);
		} catch (error) {
			logger.error(`OpenAI request handling error: ${String(error)}`);

			return reply.code(400).send({ error: { message: String(error), type: 'invalid_request_error' } });
		}
	});
};

export default plugin;
