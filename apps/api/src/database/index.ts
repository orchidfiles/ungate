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
const nativeBindingPath = process.env.UNGATE_BETTER_SQLITE3_NATIVE_BINDING;

function resolveDbPath(): string {
	return process.env.DB_PATH ?? join(homedir(), '.ungate', 'data.db');
}

/**
 * Claude/OpenAI rows in `provider_settings` can reappear after `_0011` ran when an older Ungate
 * build (pre multi-account) shares the same database file and refreshes or logs in. The row is
 * left in place so that build keeps working; its credentials are adopted only when useful:
 * - no account saved for the provider → insert `legacy-<provider>` and make it active;
 * - `legacy-<provider>` still unverified (never reconnected) and the row's token expires later
 *   (i.e. is newer) → take over its credentials;
 * - anything else → no-op (never overwrite a verified account or a newer generation).
 * Idempotent: re-running with the same row changes nothing.
 */
export function adoptLegacyOAuthRows(sqlite: DatabaseType): void {
	sqlite.transaction(() => {
		for (const provider of ['claude', 'openai']) {
			const legacy = sqlite
				.prepare(
					'SELECT access_token, refresh_token, expires_at, email, account_id, created_at FROM provider_settings WHERE provider = ?'
				)
				.get(provider) as LegacyProviderRow | undefined;
			if (!legacy?.access_token) continue;
			const id = `legacy-${provider}`;
			const count = (sqlite.prepare('SELECT count(*) AS n FROM oauth_accounts WHERE provider = ?').get(provider) as { n: number })
				.n;
			const now = Date.now();
			if (count === 0) {
				sqlite
					.prepare(
						`INSERT INTO oauth_accounts (id, provider, label, email, provider_account_id, access_token, refresh_token, expires_at, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						id,
						provider,
						legacy.email ?? `${provider} account`,
						legacy.email,
						legacy.account_id,
						legacy.access_token,
						legacy.refresh_token,
						legacy.expires_at,
						legacy.created_at,
						now
					);
				sqlite.prepare('INSERT OR IGNORE INTO oauth_policies (provider) VALUES (?)').run(provider);
				sqlite
					.prepare(
						'UPDATE oauth_policies SET active_account_id = ?, revision = revision + 1 WHERE provider = ? AND active_account_id IS NULL'
					)
					.run(id, provider);
				continue;
			}
			sqlite
				.prepare(
					`UPDATE oauth_accounts SET access_token = ?, refresh_token = ?, expires_at = ?,
					 email = COALESCE(?, email), provider_account_id = COALESCE(?, provider_account_id),
					 credential_version = credential_version + 1, needs_login = 0, updated_at = ?
					 WHERE id = ? AND provider = ? AND provider_user_id IS NULL
					 AND access_token <> ? AND COALESCE(expires_at, 0) < COALESCE(?, 0)`
				)
				.run(
					legacy.access_token,
					legacy.refresh_token,
					legacy.expires_at,
					legacy.email,
					legacy.account_id,
					now,
					id,
					provider,
					legacy.access_token,
					legacy.expires_at
				);
		}
	})();
}

interface LegacyProviderRow {
	access_token: string;
	refresh_token: string | null;
	expires_at: number | null;
	email: string | null;
	account_id: string | null;
	created_at: number;
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

		migrate(_db, { migrationsFolder: MIGRATIONS_PATH });
		adoptLegacyOAuthRows(_sqlite);
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
