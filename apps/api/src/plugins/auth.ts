import { ClientKeys } from '../database/client-keys';

import type { Config } from '../config';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

/** The key a caller presented: `Authorization: Bearer <key>` (OpenAI, Codex) or `x-api-key` (Anthropic, Claude Code). */
export function presentedKey(request: FastifyRequest): string | undefined {
	const { authorization } = request.headers;
	if (authorization?.startsWith('Bearer ')) return authorization.slice(7);

	const header = request.headers['x-api-key'];

	return Array.isArray(header) ? header[0] : header;
}

/**
 * Guards a model route and records who called it on `request.clientId`. Any client key is
 * accepted: the settings key Cursor uses, or a minted one. Client keys never open admin routes.
 */
export function clientKeyAuth(config: Config): onRequestAsyncHookHandler {
	return async (request, reply) => {
		const resolution = ClientKeys.resolve(presentedKey(request), config.apiKey);

		if (resolution.kind === 'refused') {
			return reply
				.code(403)
				.send({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized: Invalid API key' } });
		}

		request.clientId = resolution.kind === 'client' ? resolution.clientId : null;
	};
}
