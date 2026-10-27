import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import BetterSqlite3, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { schema } from './schema';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export function resolveMigrationsPath(): string {
	if (process.env.DRIZZLE_PATH) {
		return process.env.DRIZZLE_PATH;
	}

	if (import.meta.dirname) {
		return join(import.meta.dirname, '../../drizzle');
	}

	if (typeof __dirname === 'string') {
		return join(__dirname, '../drizzle');
	}

	throw new Error('Unable to resolve drizzle migrations path');
}

let _db: DrizzleDb | null = null;
let _sqlite: DatabaseType | null = null;
let _dbPath: string | null = null;
const nativeBindingPath = process.env.UNGATE_BETTER_SQLITE3_NATIVE_BINDING;

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
		const sqliteOptions = nativeBindingPath ? { nativeBinding: nativeBindingPath } : undefined;

		_sqlite = new BetterSqlite3(dbPath, sqliteOptions);
		_sqlite.pragma('journal_mode = WAL');

		_db = drizzle(_sqlite, { schema, casing: 'snake_case' });
		_dbPath = dbPath;

		migrate(_db, { migrationsFolder: resolveMigrationsPath() });
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
