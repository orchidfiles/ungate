import * as path from 'path';

// eslint-disable-next-line import-x/no-named-as-default
import Database from 'better-sqlite3';

import type * as vscode from 'vscode';

export class CursorDb {
	static readonly STORAGE_KEY =
		'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

	static resolveDbPath(context: vscode.ExtensionContext): string {
		return path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
	}

	static getOpenAIBaseUrl(dbPath: string): string | null {
		const db = new Database(dbPath, { readonly: true });

		try {
			const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(this.STORAGE_KEY) as { value: string } | undefined;

			if (!row) {
				return null;
			}

			const match = /"openAIBaseUrl":"([^"]+)"/.exec(row.value);

			return match ? match[1] : null;
		} finally {
			db.close();
		}
	}

	static setOpenAIBaseUrl(dbPath: string, newUrl: string): void {
		const db = new Database(dbPath);

		try {
			const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(this.STORAGE_KEY) as { value: string } | undefined;

			if (!row) {
				throw new Error('Cursor storage key not found');
			}

			const updated = row.value.includes('"openAIBaseUrl":')
				? row.value.replace(/"openAIBaseUrl":"[^"]*"/, `"openAIBaseUrl":"${newUrl}"`)
				: row.value.replace(/^\{/, `{"openAIBaseUrl":"${newUrl}",`);

			db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(updated, this.STORAGE_KEY);
			db.pragma('wal_checkpoint(TRUNCATE)');
		} finally {
			db.close();
		}
	}
}
