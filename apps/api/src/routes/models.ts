import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.get('/v1/models', async (_request, reply) => {
		return reply.send({
			object: 'list',
			data: [
				// Claude 4.6 models (Anthropic format)
				{
					id: 'claude-sonnet-4-6',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				{
					id: 'claude-opus-4-6',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				// Claude 4.5 models (Anthropic format)
				{
					id: 'claude-sonnet-4-5',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				{
					id: 'claude-opus-4-5',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				{
					id: 'claude-haiku-4-5',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				// Cursor format models (will be normalized)
				{
					id: 'claude-4.6-sonnet-high',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				{
					id: 'claude-4.6-opus-high',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				{
					id: 'claude-4.5-opus-high',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				{
					id: 'claude-4.5-sonnet-high',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				},
				{
					id: 'claude-4.5-haiku',
					object: 'model',
					created: 1700000000,
					owned_by: 'anthropic'
				}
			]
		});
	});
};

export default plugin;
