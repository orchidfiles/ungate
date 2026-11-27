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
import poolPlugin from './routes/pool';
import responsesPlugin from './routes/responses';
import settingsPlugin from './routes/settings';
import { cutOpenStreams, openStreamCount } from './streaming/sse-tap';

/** Dashboard webviews call account routes cross-origin; PATCH/DELETE must pass the preflight. */
export const CORS_OPTIONS: FastifyCorsOptions = { origin: '*', methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'] };

/** How long a stopping API lets open requests and streams finish before cutting them. */
export const DRAIN_TIMEOUT_MS = 30_000;
/** After the cut, how long clients get to read their terminal event before connections close. */
const CUT_GRACE_MS = 2_000;

function delay(ms: number): Promise<'timeout'> {
	return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms).unref());
}

/**
 * Stops the API without dropping work mid-answer: stop accepting connections, let open requests
 * and streams finish for up to `drainMs`, then end the streams still open with their provider's
 * terminal error event (so the client retries instead of hanging), and close what remains.
 */
export async function drainServer(app: FastifyInstance, drainMs = DRAIN_TIMEOUT_MS): Promise<void> {
	const closed = app.close();
	const first = await Promise.race([closed.then(() => 'closed' as const), delay(drainMs)]);
	if (first === 'closed') return;
	const cut = cutOpenStreams();
	logger.log(`[shutdown] drain window over; ended ${cut} open stream(s)`);
	// Connections that went idle after close() started are not reaped by it; reap them as they finish.
	const reap = setInterval(() => app.server.closeIdleConnections(), 50);
	const second = await Promise.race([closed.then(() => 'closed' as const), delay(CUT_GRACE_MS)]).finally(() =>
		clearInterval(reap)
	);
	if (second === 'closed') return;
	app.server.closeAllConnections();
	await closed;
}

/**
 * On SIGTERM/SIGINT/SIGHUP: drain the server, remove the bridge socket, then re-raise the signal
 * so whoever stopped the API still sees it exit by that signal. One handler owns the exit, so no
 * cleanup step can end the process before the drain finishes.
 */
function shutdownOnSignal(app: FastifyInstance, transport: SocketBridgeTransport | undefined): void {
	if (transport) process.once('exit', () => transport.removeSocketFile());
	const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
	const onSignal = (signal: (typeof signals)[number]) => {
		for (const other of signals) process.removeListener(other, onSignal);
		globalThis.console.log(`[shutdown] ${signal}: draining (open streams: ${openStreamCount()})`);
		void drainServer(app)
			.catch((error: unknown) => logger.error('[shutdown] drain failed:', error))
			.then(() => transport?.close())
			.finally(() => process.kill(process.pid, signal));
	};
	for (const signal of signals) process.once(signal, onSignal);
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
	await app.register(poolPlugin);
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
	let socketTransport: SocketBridgeTransport | undefined;
	if (bridgeTransport instanceof SocketBridgeTransport) {
		const socketPath = cursorBridgeSocketPath(config.port);
		await bridgeTransport.listen(socketPath);
		globalThis.console.log(`[startup] cursor bridge socket ${socketPath}`);
		socketTransport = bridgeTransport;
	}
	shutdownOnSignal(app, socketTransport);

	// Always print port to stdout — extension parses this to detect the running port.
	// Uses globalThis.console to bypass quiet mode.
	globalThis.console.log(`[ungate] listening on localhost:${config.port}`);
}
