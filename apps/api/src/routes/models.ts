import { Settings } from '../database/app-settings';
import { apiKeyAuth } from '../plugins/auth';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	// Cursor discovers models through this route, so it carries the proxy key rather than
	// the admin key. Left open it let anyone with the tunnel URL enumerate the model registry.
	app.addHook('onRequest', apiKeyAuth(app.config));

	app.get('/v1/models', async (_request, reply) => {
		const settings = Settings.get();
		const data = settings.models.map((model) => ({
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
