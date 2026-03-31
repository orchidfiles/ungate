import { OAuth } from '../auth/oauth';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.post('/auth/claude/start', async (_request, reply) => {
		const result = await OAuth.startLogin();

		return reply.send(result);
	});

	app.post('/auth/claude/complete', async (request, reply) => {
		const { code, sessionId } = request.body as { code: string; sessionId: string };

		if (!code || !sessionId) {
			return reply.code(400).send({ ok: false, error: 'Missing code or sessionId' });
		}

		const result = await OAuth.completeLogin(code, sessionId);

		return reply.send(result);
	});

	app.get('/auth/claude/status', (_request, reply) => {
		return reply.send(OAuth.getAuthStatus());
	});

	app.post('/auth/claude/logout', (_request, reply) => {
		OAuth.logout();

		return reply.send({ ok: true });
	});
};

export default plugin;
