import { OAuth } from '../auth/oauth';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.get('/health', async (_request, reply) => {
		const token = await OAuth.getValidToken();

		return reply.send({
			status: 'ok',
			claudeCode: {
				authenticated: !!token,
				expiresAt: token?.expiresAt
			}
		});
	});
};

export default plugin;
