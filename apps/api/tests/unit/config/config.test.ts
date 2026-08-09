import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BODY_LIMIT_MB } from '@ungate/shared';

import { getConfig } from 'src/config';

const DEFAULT_BODY_LIMIT_BYTES = DEFAULT_BODY_LIMIT_MB * 1024 * 1024;

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
			bodyLimitMb: DEFAULT_BODY_LIMIT_MB,
			models: []
		});

		expect(cfg).toEqual({
			port: 7777,
			apiKey: 'abc',
			quietMode: true,
			bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES
		});
	});

	it('falls back to settings when env is absent', () => {
		vi.stubEnv('PORT', '');

		const cfg = getConfig({
			port: 3000,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			bodyLimitMb: DEFAULT_BODY_LIMIT_MB,
			models: []
		});

		expect(cfg).toEqual({
			port: 3000,
			apiKey: undefined,
			quietMode: false,
			bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES
		});
	});

	it('falls back to settings when env port is invalid number', () => {
		vi.stubEnv('PORT', 'abc');

		const cfg = getConfig({
			port: 4123,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			bodyLimitMb: DEFAULT_BODY_LIMIT_MB,
			models: []
		});

		expect(cfg).toEqual({
			port: 4123,
			apiKey: undefined,
			quietMode: false,
			bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES
		});
	});

	describe('body limit', () => {
		const baseSettings = {
			port: 4123,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			models: []
		};

		it('converts the configured megabyte value to bytes', () => {
			const cfg = getConfig({ ...baseSettings, bodyLimitMb: 8 });

			expect(cfg.bodyLimitBytes).toBe(8 * 1024 * 1024);
		});

		// Fastify throws at construction on a non-positive bodyLimit, so an invalid stored
		// value must degrade to the default rather than take the whole proxy down.
		it.each([0, -1, 1e9])('falls back to the default for invalid stored value %s', (bodyLimitMb) => {
			const cfg = getConfig({ ...baseSettings, bodyLimitMb });

			expect(cfg.bodyLimitBytes).toBe(DEFAULT_BODY_LIMIT_BYTES);
		});
	});
});
