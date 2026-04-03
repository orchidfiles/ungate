import cors from '@fastify/cors';
import Fastify from 'fastify';

import { setQuietMode } from 'src/utils/logger';

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
	getDb();
	const settings = Settings.get();
	const config = getConfig(settings);
	setQuietMode(config.quietMode);

	const app = Fastify({ logger: false });
	app.decorate('config', config);

	await app.register(cors, { origin: '*' });

	await app.register(healthPlugin);
	await app.register(authPlugin);
	await app.register(anthropicPlugin);
	await app.register(openaiPlugin);
	await app.register(modelsPlugin);
	await app.register(analyticsPlugin);
	await app.register(settingsPlugin);
	await app.listen({ port: config.port, host: '0.0.0.0' });

	// Always print port to stdout — extension parses this to detect the running port.
	// Uses globalThis.console to bypass quiet mode.
	globalThis.console.log(`[ungate] listening on localhost:${config.port}`);
}
