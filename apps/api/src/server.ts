import { createServer, type Server } from 'node:http';

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { logger, setQuietMode } from 'src/utils/logger';

const BODY_LIMIT_BYTES = 256 * 1024 * 1024;

import { getConfig } from './config';
import { getDb } from './database/index';
import { Settings } from './database/settings';
import analyticsPlugin from './routes/analytics';
import anthropicPlugin from './routes/anthropic';
import authPlugin from './routes/auth';
import healthPlugin from './routes/health';
import modelsPlugin from './routes/models';
import openaiPlugin from './routes/openai';
import settingsPlugin from './routes/settings';

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
	await app.register(cors, { origin: '*' });

	globalThis.console.log('[startup] register plugins...');
	await app.register(healthPlugin);
	await app.register(authPlugin);
	await app.register(anthropicPlugin);
	await app.register(openaiPlugin);
	await app.register(modelsPlugin);
	await app.register(analyticsPlugin);
	await app.register(settingsPlugin);

	globalThis.console.log(`[startup] listen ${config.hosts.join(',')}:${config.port}...`);
	await listenOnAll(app, config.hosts, config.port);

	// Always print port to stdout — extension parses this to detect the running port.
	// Uses globalThis.console to bypass quiet mode.
	globalThis.console.log(`[ungate] listening on localhost:${config.port}`);
}

/**
 * Listens on each address in `hosts`. The first is Fastify's own server; each further address gets
 * a plain listener that hands requests to it, so routes see the real peer of every socket.
 */
export async function listenOnAll(app: FastifyInstance, hosts: string[], port: number): Promise<void> {
	const [first, ...rest] = hosts;
	const extra: Server[] = [];
	app.addHook('onClose', async () => {
		await Promise.all(extra.map((server) => new Promise((resolve) => server.close(resolve))));
	});

	await app.listen({ port, host: first });

	for (const host of rest) {
		const server = createServer((request, response) => app.server.emit('request', request, response));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, host, () => {
				server.off('error', reject);
				resolve();
			});
		});
		extra.push(server);
	}
}
