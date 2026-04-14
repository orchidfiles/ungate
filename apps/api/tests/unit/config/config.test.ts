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
			models: []
		});

		expect(cfg).toEqual({ port: 7777, apiKey: 'abc', quietMode: true });
	});

	it('falls back to settings when env is absent', () => {
		vi.stubEnv('PORT', '');

		const cfg = getConfig({
			port: 3000,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			models: []
		});

		expect(cfg).toEqual({ port: 3000, apiKey: undefined, quietMode: false });
	});

	it('falls back to settings when env port is invalid number', () => {
		vi.stubEnv('PORT', 'abc');

		const cfg = getConfig({
			port: 4123,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			models: []
		});

		expect(cfg).toEqual({ port: 4123, apiKey: undefined, quietMode: false });
	});
});
