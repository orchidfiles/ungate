import { hoursToMilliseconds } from 'date-fns';

import { Analytics } from '../database/analytics';

import type { Period } from '@ungate/shared';
import type { FastifyPluginCallback } from 'fastify';

const PERIOD_OFFSETS: Record<Exclude<Period, 'all'>, number> = {
	hour: hoursToMilliseconds(1),
	day: hoursToMilliseconds(24),
	week: hoursToMilliseconds(24 * 7),
	month: hoursToMilliseconds(24 * 30)
};

function toPeriod(value: string | undefined): Period {
	if (value === 'hour' || value === 'day' || value === 'week' || value === 'month' || value === 'all') {
		return value;
	}

	return 'day';
}

const plugin: FastifyPluginCallback = (app) => {
	app.get('/analytics', async (request, reply) => {
		const period = toPeriod((request.query as Record<string, string>).period);
		const now = Date.now();
		const since = period === 'all' ? 0 : now - PERIOD_OFFSETS[period];

		const analytics = Analytics.getSummary(since, now);

		return reply.send({
			period,
			...analytics,
			note: 'Costs are estimates. Actual costs may be lower due to prompt caching.'
		});
	});

	app.get('/analytics/requests', async (request, reply) => {
		const limitParam = (request.query as Record<string, string>).limit;
		const limit = Math.min(parseInt(limitParam ?? '100'), 1000);
		const requests = Analytics.getRecent(limit);

		return reply.send({ requests });
	});

	app.get('/analytics/tokens', async (request, reply) => {
		const period = toPeriod((request.query as Record<string, string>).period);
		const now = Date.now();
		const since = period === 'all' ? 0 : now - PERIOD_OFFSETS[period];
		const series = Analytics.getTokenSeries(period, since, now);

		return reply.send({ period, series });
	});

	app.post('/analytics/reset', async (_request, reply) => {
		const result = Analytics.reset();

		return reply.send({ success: true, ...result });
	});
};

export default plugin;
