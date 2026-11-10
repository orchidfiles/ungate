import { createRequire } from 'node:module';

interface Statement {
	get(...params: unknown[]): unknown;
}
interface Database {
	prepare(sql: string): Statement;
	close(): void;
}
type DatabaseSyncCtor = new (path: string, options: { readOnly: boolean }) => Database;

const requireBuiltin = createRequire(__filename);

function loadDatabaseSync(): DatabaseSyncCtor | null {
	try {
		const sqlite = requireBuiltin('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor };

		return sqlite.DatabaseSync ?? null;
	} catch {
		return null;
	}
}

/**
 * Reads `ItemTable` values through Node's built-in `node:sqlite` (Node ≥ 22.5, which every
 * Cursor build that blocks `vscode.cursor` ships), opened read-only per call so Cursor's own
 * writes are never contended. Returns null when the runtime has no `node:sqlite`.
 */
export function createStateDbItemReader(): ((dbPath: string, key: string) => Promise<string | null>) | null {
	const DatabaseSync = loadDatabaseSync();
	if (!DatabaseSync) return null;

	return (dbPath, key) => {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value?: unknown } | undefined;
			const value = row?.value;
			if (typeof value === 'string') return Promise.resolve(value || null);
			if (value instanceof Uint8Array) return Promise.resolve(Buffer.from(value).toString('utf8') || null);

			return Promise.resolve(null);
		} finally {
			db.close();
		}
	};
}
