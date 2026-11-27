import { OAuthAccounts } from '../database/oauth-accounts';
import { clientKeyAuth } from '../plugins/auth';

import type { PoolHealthResponse, PoolProviderName, SubscriptionProvider } from '@ungate/shared';
import type { FastifyPluginCallback } from 'fastify';

const POOL_NAME: Record<SubscriptionProvider, PoolProviderName> = { claude: 'claude', openai: 'chatgpt' };

/** Every provider whose requests run on a pool of subscription accounts. */
const POOLED: SubscriptionProvider[] = ['claude', 'openai'];

/**
 * Whether each account pool can serve a request now, for a client deciding to wait or warn
 * without spending tokens. Guarded like the model routes; answers counts only, never which
 * accounts they are.
 */
const plugin: FastifyPluginCallback = (app) => {
	app.get('/v1/pool', { onRequest: clientKeyAuth(app.config) }, async (_request, reply) => {
		const now = Date.now();
		const providers = POOLED.flatMap((provider) => {
			const health = OAuthAccounts.health(provider, now);
			if (health.total === 0) return [];

			return [
				{
					provider: POOL_NAME[provider],
					eligible: health.eligible,
					cooling_down: health.coolingDown,
					needs_login: health.needsLogin,
					earliest_reset: health.earliestReset === null ? null : new Date(health.earliestReset).toISOString()
				}
			];
		});
		const body: PoolHealthResponse = { providers };

		return reply.send(body);
	});
};

export default plugin;
