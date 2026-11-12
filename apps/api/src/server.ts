import cors, { type FastifyCorsOptions } from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { logger, setQuietMode } from 'src/utils/logger';

const BODY_LIMIT_BYTES = 256 * 1024 * 1024;

import { getConfig } from './config';
import { getDb } from './database/index';
import { Settings } from './database/settings';
import { directLocalOnly } from './plugins/local-or-api-key';
import { bridgeTransport } from './proxy/cursor-bridge-client';
import { cursorBridgeSocketPath, SocketBridgeTransport } from './proxy/cursor-bridge-transport';
import analyticsPlugin from './routes/analytics';
import anthropicPlugin from './routes/anthropic';
import authPlugin from './routes/auth';
import clientPlugin from './routes/client';
import clientsPlugin from './routes/clients';
import cursorPlugin from './routes/cursor';
import healthPlugin from './routes/health';
import modelsPlugin from './routes/models';
import openaiPlugin from './routes/openai';
import responsesPlugin from './routes/responses';
import settingsPlugin from './routes/settings';

/** Dashboard webviews call account routes cross-origin; PATCH/DELETE must pass the preflight. */
export const CORS_OPTIONS: FastifyCorsOptions = { origin: '*', methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'] };

/**
 * Removes the bridge socket when the API stops. A signal is re-raised after cleanup so whoever
 * stopped the API still sees it exit by that signal.
 */
function removeSocketOnShutdown(transport: SocketBridgeTransport): void {
	process.once('exit', () => transport.removeSocketFile());
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
		process.once(signal, () => {
			void transport.close().finally(() => process.kill(process.pid, signal));
		});
	}
}

/**
 * Model routes (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`) take a client key and
 * record the client, and `/v1/client` names the key's client; `/health` and the `/v1/models` list
 * stay open. Everything else reads or changes state and
 * answers only direct loopback requests, whatever key is sent; see `directLocalOnly`.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
	app.decorateRequest('clientId', null);

	await app.register(healthPlugin);
	await app.register(anthropicPlugin);
	await app.register(openaiPlugin);
	await app.register(responsesPlugin);
	await app.register(clientPlugin);
	await app.register(modelsPlugin);

	await app.register(async (admin) => {
		admin.addHook('onRequest', directLocalOnly);
		await admin.register(authPlugin);
		await admin.register(cursorPlugin);
		await admin.register(analyticsPlugin);
		await admin.register(settingsPlugin);
		await admin.register(clientsPlugin);
	});
}

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
	await app.register(cors, CORS_OPTIONS);

	globalThis.console.log('[startup] register plugins...');
	await registerRoutes(app);

	globalThis.console.log(`[startup] listen ${config.port}...`);
	await app.listen({ port: config.port, host: '0.0.0.0' });

	// After the port is ours, so a second run that fails on the port never replaces a live socket.
	// The leader window retries the socket on every runtime sync.
	if (bridgeTransport instanceof SocketBridgeTransport) {
		const socketPath = cursorBridgeSocketPath(config.port);
		await bridgeTransport.listen(socketPath);
		globalThis.console.log(`[startup] cursor bridge socket ${socketPath}`);
		removeSocketOnShutdown(bridgeTransport);
	}

	// Always print port to stdout — extension parses this to detect the running port.
	// Uses globalThis.console to bypass quiet mode.
	globalThis.console.log(`[ungate] listening on localhost:${config.port}`);
}
