import { basename, join } from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

import { getCurrentDbPath, getDb, getSqlite, schema } from 'src/database';

export function resetIntegrationDatabase(): void {
	const sqlite = getSqlite();

	sqlite.exec('BEGIN');

	try {
		sqlite.exec('PRAGMA foreign_keys = OFF;');
		sqlite.exec('DELETE FROM requests;');
		sqlite.exec('DELETE FROM provider_settings;');
		sqlite.exec('DELETE FROM model_mappings;');
		sqlite.exec('DELETE FROM app_settings;');
		sqlite.exec("DELETE FROM sqlite_sequence WHERE name = 'requests';");
		sqlite.exec('PRAGMA foreign_keys = ON;');
		sqlite.exec('COMMIT');
	} catch (error) {
		sqlite.exec('ROLLBACK');
		throw error;
	}
}

beforeEach(() => {
	const expectedTestDb = join(process.env.HOME ?? '', '.ungate', 'ungate-test.db');
	const actualDbPath = getCurrentDbPath();

	if (actualDbPath !== expectedTestDb || basename(actualDbPath) !== 'ungate-test.db') {
		throw new Error(`Integration tests must use test database "${expectedTestDb}", got "${actualDbPath}".`);
	}

	if (vi.isMockFunction(getDb)) {
		throw new Error('Integration tests must not mock src/database/index.');
	}

	if (vi.isMockFunction(schema.appSettings.id)) {
		throw new Error('Integration tests must not mock drizzle helpers or schema exports.');
	}

	resetIntegrationDatabase();
});

afterEach(() => {
	vi.clearAllMocks();
});
