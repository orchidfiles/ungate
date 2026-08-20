import Fastify, { type FastifyInstance, type FastifyPluginCallback } from 'fastify';

import { ADMIN_KEY_HEADER } from '@ungate/shared';

/** Stand-in for the 256-bit key the extension mints; length matches a hex-encoded key. */
export const TEST_ADMIN_KEY = 'f'.repeat(64);

export const ADMIN_HEADERS = { [ADMIN_KEY_HEADER]: TEST_ADMIN_KEY };

export interface HarnessConfig {
	apiKey?: string;
	adminApiKey?: string;
}

export function createTestApp(config: HarnessConfig = {}): FastifyInstance {
	const app = Fastify({ logger: false });
	app.decorate('config', {
		port: 0,
		apiKey: config.apiKey,
		adminApiKey: config.adminApiKey ?? TEST_ADMIN_KEY,
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
