import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import BetterSqlite3, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { schema } from './schema';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_PATH = process.env.DRIZZLE_PATH ?? join(import.meta.dirname, '../../drizzle');
const DB_PATH = process.env.DB_PATH ?? join(homedir(), '.ungate', 'data.db');

let _db: DrizzleDb | null = null;
let _sqlite: DatabaseType | null = null;

export function getDb(): DrizzleDb {
	if (!_db) {
		mkdirSync(dirname(DB_PATH), { recursive: true });

		_sqlite = new BetterSqlite3(DB_PATH);
		_sqlite.pragma('journal_mode = WAL');

		_db = drizzle(_sqlite, { schema, casing: 'snake_case' });

		migrate(_db, { migrationsFolder: MIGRATIONS_PATH });
	}

	return _db;
}

export function getSqlite(): DatabaseType {
	getDb();

	return _sqlite!;
}

export { schema };
