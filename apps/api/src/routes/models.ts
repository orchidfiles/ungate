import { Settings } from '../database/app-settings';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.get('/v1/models', async (_request, reply) => {
		const settings = Settings.get();
		const models = settings.models.filter((m) => m.enabled);
		const data = models.map((model) => ({
			id: model.id,
			object: 'model' as const,
			created: 1700000000,
			owned_by: model.provider
		}));

		return reply.send({
			object: 'list',
			data
		});
	});
};

export default plugin;
