import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Headers cloudflared (or any reverse proxy) adds; their presence means the call came through the tunnel. */
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'forwarded'];

export function isDirectLocalRequest(request: FastifyRequest): boolean {
	if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) return false;

	return !PROXY_HEADERS.some((header) => request.headers[header] !== undefined);
}

/**
 * Admin routes (accounts, settings, analytics, clients) answer only the local dashboard. No key
 * opens them: model keys are handed to tools and tunnels, which must not be able to sign accounts
 * out, read settings or mint keys.
 */
export const directLocalOnly: onRequestAsyncHookHandler = async (request, reply) => {
	if (isDirectLocalRequest(request)) return;

	return reply.code(403).send({ error: 'Admin routes accept only direct local requests', code: 'forbidden' });
};
