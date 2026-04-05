import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import BetterSqlite3, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { schema } from './schema';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_PATH = process.env.DRIZZLE_PATH ?? join(import.meta.dirname, '../../drizzle');

let _db: DrizzleDb | null = null;
let _sqlite: DatabaseType | null = null;
let _dbPath: string | null = null;

function resolveDbPath(): string {
	return process.env.DB_PATH ?? join(homedir(), '.ungate', 'data.db');
}

export function getCurrentDbPath(): string {
	return _dbPath ?? resolveDbPath();
}

export function getDb(): DrizzleDb {
	const dbPath = resolveDbPath();

	if (!_db) {
		mkdirSync(dirname(dbPath), { recursive: true });

		_sqlite = new BetterSqlite3(dbPath);
		_sqlite.pragma('journal_mode = WAL');

		_db = drizzle(_sqlite, { schema, casing: 'snake_case' });
		_dbPath = dbPath;

		migrate(_db, { migrationsFolder: MIGRATIONS_PATH });
	} else if (_dbPath !== dbPath) {
		throw new Error(
			`Database already initialized with "${_dbPath}", but current DB_PATH is "${dbPath}". Restart process to switch database.`
		);
	}

	return _db;
}

export function getSqlite(): DatabaseType {
	getDb();

	return _sqlite!;
}

export { schema };
