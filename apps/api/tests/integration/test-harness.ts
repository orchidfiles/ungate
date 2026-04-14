import Fastify, { type FastifyInstance, type FastifyPluginCallback } from 'fastify';

export interface HarnessConfig {
	apiKey?: string;
}

export function createTestApp(config: HarnessConfig = {}): FastifyInstance {
	const app = Fastify({ logger: false });
	app.decorate('config', {
		port: 0,
		apiKey: config.apiKey,
		quietMode: true
	});

	return app;
}

export async function withPlugin(plugin: FastifyPluginCallback, config: HarnessConfig = {}): Promise<FastifyInstance> {
	const app = createTestApp(config);
	await app.register(plugin);
	await app.ready();

	return app;
}
