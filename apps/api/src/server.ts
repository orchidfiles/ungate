import cors from '@fastify/cors';
import Fastify from 'fastify';

import { ADMIN_KEY_HEADER } from '@ungate/shared';
import { logger, setQuietMode } from 'src/utils/logger';

import { getConfig } from './config';
import { getDb } from './database/index';
import { Settings } from './database/settings';
import { isAllowedDashboardOrigin } from './plugins/cors-origin';
import analyticsPlugin from './routes/analytics';
import anthropicPlugin from './routes/anthropic';
import authPlugin from './routes/auth';
import healthPlugin from './routes/health';
import modelsPlugin from './routes/models';
import openaiPlugin from './routes/openai';
import settingsPlugin from './routes/settings';

const BODY_LIMIT_BYTES = 256 * 1024 * 1024;

// Cursor reaches the API through the Cloudflare tunnel, never by connecting to a LAN
// interface. Binding loopback keeps every other host on the network out.
export const LISTEN_HOST = '127.0.0.1';

export async function startServer(): Promise<void> {
	globalThis.console.log('[startup] getDb...');
	getDb();

	globalThis.console.log('[startup] Settings.get...');
	const settings = Settings.get();
	const config = getConfig(settings);
	setQuietMode(config.quietMode);

	const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
	app.decorate('config', config);

	// Oversized bodies are rejected before any route runs. onError observes them without
	// replacing Fastify's default handler, which preserves the standard 413 response.
	app.addHook('onError', (request, _reply, error, done) => {
		if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
			const contentLength = request.headers['content-length'] ?? 'unknown';

			logger.error(`Request body too large: ${contentLength} bytes exceeds the ${BODY_LIMIT_BYTES}-byte limit.`);
		}

		done();
	});

	globalThis.console.log('[startup] register cors...');
	await app.register(cors, {
		origin: (origin, callback) => {
			callback(null, isAllowedDashboardOrigin(origin));
		},
		credentials: false,
		allowedHeaders: ['content-type', 'authorization', 'x-api-key', ADMIN_KEY_HEADER]
	});

	globalThis.console.log('[startup] register plugins...');
	await app.register(healthPlugin);
	await app.register(authPlugin);
	await app.register(anthropicPlugin);
	await app.register(openaiPlugin);
	await app.register(modelsPlugin);
	await app.register(analyticsPlugin);
	await app.register(settingsPlugin);

	globalThis.console.log(`[startup] listen ${config.port}...`);
	await app.listen({ port: config.port, host: LISTEN_HOST });

	// Always print port to stdout — extension parses this to detect the running port.
	// Uses globalThis.console to bypass quiet mode.
	globalThis.console.log(`[ungate] listening on localhost:${config.port}`);
}
