import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.get('/health', async (_request, reply) => {
		return reply.send({
			status: 'ok'
		});
	});
};

export default plugin;
