import { ClientKeys } from '../database/client-keys';
import { clientKeyAuth } from '../plugins/auth';

import type { WhoAmIResponse } from '@ungate/shared';
import type { FastifyPluginCallback } from 'fastify';

/**
 * Which client the presented key belongs to, for a caller checking its key without spending
 * tokens. Guarded like the model routes, so a refused key gets the same 403.
 */
const plugin: FastifyPluginCallback = (app) => {
	app.get('/v1/client', { onRequest: clientKeyAuth(app.config) }, async (request, reply) => {
		const client = request.clientId === null ? undefined : ClientKeys.list().find(({ id }) => id === request.clientId);
		const body: WhoAmIResponse = { client: client ? { id: client.id, label: client.label } : null };

		return reply.send(body);
	});
};

export default plugin;
