import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveMigrationsPath } from 'src/database';

describe('resolveMigrationsPath', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('uses DRIZZLE_PATH when set', () => {
		vi.stubEnv('DRIZZLE_PATH', '/custom/drizzle');

		expect(resolveMigrationsPath()).toBe('/custom/drizzle');
	});

	it('returns a concrete path when DRIZZLE_PATH is absent', () => {
		vi.stubEnv('DRIZZLE_PATH', '');
		delete process.env.DRIZZLE_PATH;

		const migrationsPath = resolveMigrationsPath();

		expect(migrationsPath.length).toBeGreaterThan(0);
		expect(migrationsPath).not.toContain('undefined');
		expect(migrationsPath.endsWith('drizzle')).toBe(true);
	});
});
