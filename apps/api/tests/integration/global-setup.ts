import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TEST_DB_PATH = join(process.env.HOME ?? '', '.ungate', 'ungate-test.db');
const KEEP_DB_AFTER_TESTS = process.env.UNGATE_KEEP_TEST_DB === '1';

function removeTestDb(): void {
	rmSync(TEST_DB_PATH, { force: true });
}

export default function globalSetup() {
	process.env.DB_PATH = TEST_DB_PATH;
	process.env.NODE_ENV = 'test';
	mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
	removeTestDb();

	return () => {
		if (!KEEP_DB_AFTER_TESTS) {
			removeTestDb();
		}
	};
}
