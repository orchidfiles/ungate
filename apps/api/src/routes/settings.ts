import { Settings } from '../database/app-settings';

import type { AppSettings } from '@ungate/shared';
import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.get('/settings', async (_request, reply) => {
		const settings = Settings.get();

		return reply.send(settings);
	});

	app.post('/settings', async (request, reply) => {
		const body = request.body as Partial<AppSettings>;
		Settings.update(body);

		return reply.send({ ok: true });
	});
};

export default plugin;
