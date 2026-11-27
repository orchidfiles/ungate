import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Sqlite3CliResolver } from './sqlite3-cli-resolver';

const execFileAsync = promisify(execFile);

export const SQLITE_CLI_UNAVAILABLE_REASON = 'SQLite CLI could not be prepared';

type InstallLogger = (message: string) => void;

function isMissingBinary(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Reads Cursor's `state.vscdb` through the sqlite3 CLI. The CLI path is never frozen: an
 * unresolved path is retried on the next read, and a path whose binary disappeared (`ENOENT`,
 * e.g. a Nix store path garbage-collected after an update) is resolved again once.
 */
export class CursorStateDbReader {
	/** A failed resolve may log or download, so it is not repeated more often than this. */
	static readonly RESOLVE_RETRY_MS = 60_000;

	private cliPath: string | null = null;
	private lastFailedResolveAt: number | null = null;

	constructor(
		private readonly onLog?: InstallLogger,
		private readonly now: () => number = Date.now
	) {}

	async init(): Promise<string | null> {
		await this.ensureCliPath();

		return this.cliPath ? null : SQLITE_CLI_UNAVAILABLE_REASON;
	}

	async readItemTableValue(dbPath: string, key: string): Promise<string | null> {
		const cliPath = await this.ensureCliPath();

		if (!cliPath) {
			return null;
		}

		try {
			return await this.query(cliPath, dbPath, key);
		} catch (error) {
			if (!isMissingBinary(error)) throw error;
			this.cliPath = null;
			this.lastFailedResolveAt = null;
			const retryPath = await this.ensureCliPath();
			if (!retryPath) return null;

			return await this.query(retryPath, dbPath, key);
		}
	}

	private async ensureCliPath(): Promise<string | null> {
		if (this.cliPath) return this.cliPath;

		if (this.lastFailedResolveAt !== null && this.now() - this.lastFailedResolveAt < CursorStateDbReader.RESOLVE_RETRY_MS) {
			return null;
		}

		this.cliPath = await Sqlite3CliResolver.resolve(this.onLog);
		this.lastFailedResolveAt = this.cliPath ? null : this.now();

		return this.cliPath;
	}

	private async query(cliPath: string, dbPath: string, key: string): Promise<string | null> {
		const escapedKey = key.replaceAll("'", "''");
		const query = `SELECT value FROM ItemTable WHERE key = '${escapedKey}';`;
		const { stdout } = await execFileAsync(cliPath, [dbPath, query]);
		const raw = stdout.trim();

		return raw || null;
	}
}
