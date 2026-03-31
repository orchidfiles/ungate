import { logger } from 'src/utils/logger';

import { HeadersExtractor } from '../handlers/headers-extractor';
import { apiKeyAuth } from '../plugins/auth';
import { proxyRequest } from '../proxy/anthropic-client';

import type { AnthropicRequest, AnthropicError } from '../types';
import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/messages', { preHandler: apiKeyAuth(config) }, async (request, reply) => {
		try {
			HeadersExtractor.logRequestDetails(request.headers, request.url, request.method, 'Anthropic /v1/messages');

			const body = request.body as AnthropicRequest;
			const headers = HeadersExtractor.extractAnthropicHeaders(request.headers);

			logger.log(`→ Model: "${body.model}" | ${body.stream ? 'stream' : 'sync'} | max_tokens=${body.max_tokens}`);

			const { response } = await proxyRequest('/v1/messages', body, headers);

			for (const [key, value] of response.headers.entries()) {
				if (key.toLowerCase() !== 'content-encoding') {
					reply.header(key, value);
				}
			}

			reply.code(response.status);

			if (response.body) {
				return reply.send(response.body);
			}

			const fallbackBody = await response.arrayBuffer();

			return reply.send(fallbackBody);
		} catch (error) {
			logger.error(`Request handling error: ${String(error)}`);

			const errorBody: AnthropicError = {
				type: 'error',
				error: { type: 'invalid_request_error', message: String(error) }
			};

			return reply.code(400).send(errorBody);
		}
	});
};

export default plugin;
