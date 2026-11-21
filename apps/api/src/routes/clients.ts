import { z } from 'zod';

import { ClientKeys, ClientNotFoundError, SettingsClientImmutableError } from '../database/client-keys';

import { periodWindow } from './analytics';

import type { ClientKeyCreateResponse, ClientKeyListResponse } from '@ungate/shared';
import type { FastifyPluginCallback } from 'fastify';

const labelSchema = z.object({ label: z.string().trim().min(1).max(100) });

interface IdParams {
	Params: { id: string };
}

/** Client keys for the model routes. Registered in the direct-local admin scope (see `registerRoutes`). */
const plugin: FastifyPluginCallback = (app) => {
	const list = (): ClientKeyListResponse => ({ clients: ClientKeys.list() });

	app.get('/clients', async (_request, reply) => reply.send(list()));

	app.post('/clients', async (request, reply) => {
		const parsed = labelSchema.safeParse(request.body ?? {});
		if (!parsed.success)
			return reply.code(400).send({ error: 'A label of 1–100 characters is required', code: 'invalid_request' });

		const { client, key } = ClientKeys.create(parsed.data.label);
		const body: ClientKeyCreateResponse = { client, key, ...list() };

		return reply.send(body);
	});

	app.patch<IdParams>('/clients/:id', async (request, reply) => {
		const parsed = labelSchema.safeParse(request.body ?? {});
		if (!parsed.success)
			return reply.code(400).send({ error: 'A label of 1–100 characters is required', code: 'invalid_request' });

		try {
			ClientKeys.rename(request.params.id, parsed.data.label);
		} catch (error) {
			if (error instanceof ClientNotFoundError) return reply.code(404).send({ error: error.message, code: 'client_not_found' });
			throw error;
		}

		return reply.send(list());
	});

	app.post<IdParams>('/clients/:id/revoke', async (request, reply) => {
		try {
			ClientKeys.revoke(request.params.id);
		} catch (error) {
			if (error instanceof ClientNotFoundError) return reply.code(404).send({ error: error.message, code: 'client_not_found' });
			if (error instanceof SettingsClientImmutableError) {
				return reply.code(409).send({ error: error.message, code: 'settings_client' });
			}
			throw error;
		}

		return reply.send(list());
	});

	app.get('/analytics/clients', async (request, reply) => {
		const { period, since, until } = periodWindow((request.query as Record<string, string>).period);

		return reply.send({ period, clients: ClientKeys.usage(since, until) });
	});
};

export default plugin;
