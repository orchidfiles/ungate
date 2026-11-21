import type { Config } from '../config';

declare module 'fastify' {
	interface FastifyInstance {
		config: Config;
	}
	interface FastifyRequest {
		/** Set by `clientKeyAuth` on model routes; null when the routes are open or the route is not a model route. */
		clientId: string | null;
	}
}
