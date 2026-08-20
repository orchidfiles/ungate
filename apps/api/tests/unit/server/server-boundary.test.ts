import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_KEY_ENV, ADMIN_KEY_HEADER } from '@ungate/shared';
import { LISTEN_HOST, startServer } from 'src/server';

import type { FastifyCorsOptions, OriginFunction } from '@fastify/cors';

const ADMIN_KEY = 'f'.repeat(64);

const fastifyFactoryMock = vi.fn();
const decorateMock = vi.fn();
const addHookMock = vi.fn();
const registerMock = vi.fn();
const listenMock = vi.fn();
const settingsGetMock = vi.fn();
const getDbMock = vi.fn();

vi.mock('fastify', () => ({
	default: (...args: unknown[]) => fastifyFactoryMock(...args)
}));

vi.mock('@fastify/cors', () => ({
	default: 'cors-plugin'
}));

vi.mock('src/database/index', () => ({
	getDb: (...args: unknown[]) => getDbMock(...args),
	getSqlite: vi.fn(),
	getCurrentDbPath: vi.fn(),
	schema: {}
}));

vi.mock('src/database/settings', () => ({
	Settings: { get: (...args: unknown[]) => settingsGetMock(...args) }
}));

function corsOptions(): FastifyCorsOptions {
	const registration = registerMock.mock.calls.find(([plugin]) => plugin === 'cors-plugin');

	if (!registration) {
		throw new Error('CORS plugin was never registered');
	}

	return registration[1] as FastifyCorsOptions;
}

function resolveOrigin(origin: string | undefined): boolean {
	// The server registers the callback form of `origin`; the FastifyCorsOptions union also covers
	// static values and async delegates, so it cannot narrow to that form structurally.
	const policy = corsOptions().origin as OriginFunction;

	if (typeof policy !== 'function') {
		throw new Error('CORS origin must be decided by a policy function, not a static value');
	}

	let allowed: unknown;

	policy(origin, (error, allow) => {
		if (error) throw error;
		allowed = allow;
	});

	if (typeof allowed !== 'boolean') {
		throw new Error(`CORS origin policy answered with ${String(allowed)} instead of a boolean`);
	}

	return allowed;
}

describe('server boundary', () => {
	beforeEach(() => {
		vi.stubEnv(ADMIN_KEY_ENV, ADMIN_KEY);
		vi.stubEnv('PORT', '');
		vi.spyOn(globalThis.console, 'log').mockImplementation(() => {});

		fastifyFactoryMock.mockReturnValue({
			decorate: decorateMock,
			addHook: addHookMock,
			register: registerMock,
			listen: listenMock
		});
		registerMock.mockResolvedValue(undefined);
		listenMock.mockResolvedValue(undefined);
		settingsGetMock.mockReturnValue({
			port: 4783,
			apiKey: 'proxy-key',
			quiet: true,
			extraInstruction: null,
			models: []
		});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('listens on loopback only, never a LAN interface', async () => {
		await startServer();

		expect(LISTEN_HOST).toBe('127.0.0.1');
		expect(listenMock).toHaveBeenCalledWith({ port: 4783, host: '127.0.0.1' });
	});

	it('hands the environment admin key to the request pipeline', async () => {
		await startServer();

		expect(decorateMock).toHaveBeenCalledWith(
			'config',
			expect.objectContaining({ adminApiKey: ADMIN_KEY, apiKey: 'proxy-key' })
		);
	});

	it('refuses to start without an admin key', async () => {
		vi.stubEnv(ADMIN_KEY_ENV, '');

		await expect(startServer()).rejects.toThrow(ADMIN_KEY_ENV);
		expect(listenMock).not.toHaveBeenCalled();
	});

	it('replaces wildcard CORS with an origin policy', async () => {
		await startServer();

		expect(corsOptions().origin).not.toBe('*');
		expect(resolveOrigin('vscode-webview://1a2b3c4d-5e6f-7788-99aa-bbccddeeff00')).toBe(true);
		expect(resolveOrigin(undefined)).toBe(true);
		expect(resolveOrigin('https://evil.example')).toBe(false);
		expect(resolveOrigin('https://random-words-1234.trycloudflare.com')).toBe(false);
	});

	it('permits the admin key header through CORS preflight', async () => {
		await startServer();

		expect(corsOptions().allowedHeaders).toContain(ADMIN_KEY_HEADER);
		expect(corsOptions().credentials).toBe(false);
	});
});
