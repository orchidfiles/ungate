import type { Config } from '../config';
import type { preHandlerAsyncHookHandler } from 'fastify';

export function apiKeyAuth(config: Config): preHandlerAsyncHookHandler {
	return async (request, reply) => {
		if (!config.apiKey) return;
		const bearer = request.headers.authorization?.slice(7);
		const key = bearer ?? (request.headers['x-api-key'] as string | undefined);
		if (key !== config.apiKey) {
			return reply
				.code(403)
				.send({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized: Invalid API key' } });
		}
	};
}
