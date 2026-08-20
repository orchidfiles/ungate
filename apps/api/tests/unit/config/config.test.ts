import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_KEY_ENV } from '@ungate/shared';
import { getConfig } from 'src/config';

const ADMIN_KEY = 'f'.repeat(64);

describe('config', () => {
	beforeEach(() => {
		vi.stubEnv(ADMIN_KEY_ENV, ADMIN_KEY);
	});

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

		expect(cfg).toEqual({ port: 7777, apiKey: 'abc', adminApiKey: ADMIN_KEY, quietMode: true });
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

		expect(cfg).toEqual({ port: 3000, apiKey: undefined, adminApiKey: ADMIN_KEY, quietMode: false });
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

		expect(cfg).toEqual({ port: 4123, apiKey: undefined, adminApiKey: ADMIN_KEY, quietMode: false });
	});

	it('refuses to build a config when the admin key is absent', () => {
		vi.stubEnv(ADMIN_KEY_ENV, '');

		expect(() =>
			getConfig({ port: 4123, apiKey: null, quiet: false, extraInstruction: null, models: [] })
		).toThrowError(ADMIN_KEY_ENV);
	});

	it('refuses an admin key too short to carry 256 bits', () => {
		vi.stubEnv(ADMIN_KEY_ENV, 'short-key');

		expect(() =>
			getConfig({ port: 4123, apiKey: null, quiet: false, extraInstruction: null, models: [] })
		).toThrowError(ADMIN_KEY_ENV);
	});

	it('accepts a base64url-encoded 256-bit key', () => {
		const base64UrlKey = 'A'.repeat(43);
		vi.stubEnv(ADMIN_KEY_ENV, base64UrlKey);
		vi.stubEnv('PORT', '');

		const cfg = getConfig({ port: 4123, apiKey: null, quiet: false, extraInstruction: null, models: [] });

		expect(cfg.adminApiKey).toBe(base64UrlKey);
	});
});
