import { ModelMappings } from 'src/database/model-mappings';
import { CompletionModelRouting } from 'src/orchestration/openai';
import { ClaudeChatHandler, MiniMaxChatHandler, OpenAiMappedChatHandler } from 'src/orchestration/openai/provider-handlers';
import { apiKeyAuth } from 'src/plugins/auth';
import { logger } from 'src/utils/logger';

import type { FastifyPluginCallback } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/chat/completions', { preHandler: apiKeyAuth(config) }, async (request, reply) => {
		try {
			const openaiBody = request.body as OpenAIChatRequest;
			const resolvedModel = ModelMappings.resolveForChatCompletion(openaiBody.model);

			// Branch order matters: MiniMax (mapping or name prefix) before DB-mapped OpenAI, then default Claude path.
			if (CompletionModelRouting.shouldRouteMiniMax(resolvedModel, openaiBody.model)) {
				return MiniMaxChatHandler.handle(openaiBody, resolvedModel, reply);
			}

			if (CompletionModelRouting.isOpenAiMapped(resolvedModel)) {
				return OpenAiMappedChatHandler.handle(openaiBody, resolvedModel, reply);
			}

			return ClaudeChatHandler.handle(request, openaiBody, resolvedModel, reply);
		} catch (error) {
			logger.error(`OpenAI request handling error: ${String(error)}`);

			return reply.code(400).send({ error: { message: String(error), type: 'invalid_request_error' } });
		}
	});
};

export default plugin;
