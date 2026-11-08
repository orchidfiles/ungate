import type { Config } from '../config';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Headers cloudflared (or any reverse proxy) adds; their presence means the call came through the tunnel. */
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'forwarded'];

export function isDirectLocalRequest(request: FastifyRequest): boolean {
	if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) return false;

	return !PROXY_HEADERS.some((header) => request.headers[header] !== undefined);
}

/**
 * Allows the local dashboard (direct loopback) without a key. Tunnelled requests must carry the
 * configured API key; with no key configured they are refused outright.
 */
export function localOrApiKey(config: Config): onRequestAsyncHookHandler {
	return async (request, reply) => {
		if (isDirectLocalRequest(request)) return;

		const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
		const key = bearer ?? (request.headers['x-api-key'] as string | undefined);

		if (!config.apiKey || key !== config.apiKey) {
			return reply.code(403).send({ error: 'Forbidden', code: 'forbidden' });
		}
	};
}
