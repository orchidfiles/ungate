import { afterEach, describe, expect, it, vi } from 'vitest';

import { getConfig } from 'src/config';

describe('config', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('uses env port over settings', () => {
		vi.stubEnv('PORT', '7777');

		const cfg = getConfig({
			port: 1234,
			apiKey: 'abc',
			quiet: true,
			extraInstruction: '',
			claudeCliVersionMode: 'stable',
			claudeCliVersionCustom: null,
			models: []
		});

		expect(cfg).toEqual({ port: 7777, apiKey: 'abc', quietMode: true, hosts: ['0.0.0.0'] });
	});

	it('falls back to settings when env is absent', () => {
		vi.stubEnv('PORT', '');

		const cfg = getConfig({
			port: 3000,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			claudeCliVersionMode: 'stable',
			claudeCliVersionCustom: null,
			models: []
		});

		expect(cfg).toEqual({ port: 3000, apiKey: undefined, quietMode: false, hosts: ['0.0.0.0'] });
	});

	it('falls back to settings when env port is invalid number', () => {
		vi.stubEnv('PORT', 'abc');

		const cfg = getConfig({
			port: 4123,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			claudeCliVersionMode: 'stable',
			claudeCliVersionCustom: null,
			models: []
		});

		expect(cfg).toEqual({ port: 4123, apiKey: undefined, quietMode: false, hosts: ['0.0.0.0'] });
	});

	it('listens on each HOST address, trimmed, in order', () => {
		vi.stubEnv('HOST', ' 127.0.0.1, 10.233.1.1 ,');

		const cfg = getConfig({
			port: 4123,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			claudeCliVersionMode: 'stable',
			claudeCliVersionCustom: null,
			models: []
		});

		expect(cfg.hosts).toEqual(['127.0.0.1', '10.233.1.1']);
	});
});
