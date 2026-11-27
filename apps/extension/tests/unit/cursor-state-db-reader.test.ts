import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		resolveMock: vi.fn(),
		execFileMock: vi.fn()
	};
});

vi.mock('../../src/utils/sqlite3-cli-resolver', () => {
	return {
		Sqlite3CliResolver: {
			resolve: mocks.resolveMock
		}
	};
});

vi.mock('node:child_process', () => {
	return {
		execFile: mocks.execFileMock
	};
});

import { CursorStateDbReader } from '../../src/utils/cursor-state-db-reader';

describe('CursorStateDbReader', () => {
	beforeEach(() => {
		mocks.resolveMock.mockReset();
		mocks.execFileMock.mockReset();
	});

	it('reads ItemTable values through the resolved sqlite3 CLI', async () => {
		mocks.resolveMock.mockResolvedValue('/usr/bin/sqlite3');
		mocks.execFileMock.mockImplementation(
			(_command: string, _args: string[], callback: (error: null, result: { stdout: string }) => void) => {
				callback(null, { stdout: '{"useOpenAIKey":true}\n' });
			}
		);

		const reader = new CursorStateDbReader();

		const initResult = await reader.init();
		const value = await reader.readItemTableValue('/tmp/state.vscdb', 'cursorAuth/openAIKey');

		expect(initResult).toBeNull();
		expect(value).toBe('{"useOpenAIKey":true}');
		expect(mocks.execFileMock).toHaveBeenCalledWith(
			'/usr/bin/sqlite3',
			['/tmp/state.vscdb', "SELECT value FROM ItemTable WHERE key = 'cursorAuth/openAIKey';"],
			expect.any(Function)
		);
	});

	it('reports unavailable when sqlite3 CLI cannot be resolved', async () => {
		mocks.resolveMock.mockResolvedValue(null);

		const reader = new CursorStateDbReader();

		const initResult = await reader.init();
		const value = await reader.readItemTableValue('/tmp/state.vscdb', 'cursorAuth/openAIKey');

		expect(initResult).toBe('SQLite CLI could not be prepared');
		expect(value).toBeNull();
	});

	it('caches a resolved CLI path', async () => {
		mocks.resolveMock.mockResolvedValue('/usr/bin/sqlite3');

		const reader = new CursorStateDbReader();

		const firstInit = await reader.init();
		const secondInit = await reader.init();

		expect(firstInit).toBeNull();
		expect(secondInit).toBeNull();
		expect(mocks.resolveMock).toHaveBeenCalledTimes(1);
	});

	it('re-resolves the CLI once when the cached binary is gone (ENOENT)', async () => {
		mocks.resolveMock.mockResolvedValueOnce('/nix/store/old/bin/sqlite3').mockResolvedValueOnce('/nix/store/new/bin/sqlite3');
		mocks.execFileMock.mockImplementation(
			(command: string, _args: string[], callback: (error: unknown, result?: { stdout: string }) => void) => {
				if (command === '/nix/store/old/bin/sqlite3') {
					callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

					return;
				}
				callback(null, { stdout: 'value\n' });
			}
		);

		const reader = new CursorStateDbReader();
		await reader.init();

		await expect(reader.readItemTableValue('/tmp/state.vscdb', 'k')).resolves.toBe('value');
		expect(mocks.resolveMock).toHaveBeenCalledTimes(2);
		await expect(reader.readItemTableValue('/tmp/state.vscdb', 'k')).resolves.toBe('value');
		expect(mocks.resolveMock).toHaveBeenCalledTimes(2);
	});

	it('does not swallow non-ENOENT query failures', async () => {
		mocks.resolveMock.mockResolvedValue('/usr/bin/sqlite3');
		mocks.execFileMock.mockImplementation((_c: string, _a: string[], callback: (error: unknown) => void) => {
			callback(Object.assign(new Error('database is locked'), { code: 5 }));
		});

		const reader = new CursorStateDbReader();

		await expect(reader.readItemTableValue('/tmp/state.vscdb', 'k')).rejects.toThrow('database is locked');
		expect(mocks.resolveMock).toHaveBeenCalledTimes(1);
	});

	it('retries an unresolved CLI after the throttle window instead of failing forever', async () => {
		let now = 0;
		mocks.resolveMock.mockResolvedValueOnce(null).mockResolvedValueOnce('/usr/bin/sqlite3');

		const reader = new CursorStateDbReader(undefined, () => now);

		const first = await reader.init();
		now += 1_000;
		const throttled = await reader.init();
		expect(first).toBe('SQLite CLI could not be prepared');
		expect(throttled).toBe('SQLite CLI could not be prepared');
		expect(mocks.resolveMock).toHaveBeenCalledTimes(1);

		now += CursorStateDbReader.RESOLVE_RETRY_MS;
		const recovered = await reader.init();
		expect(recovered).toBeNull();
		expect(mocks.resolveMock).toHaveBeenCalledTimes(2);
	});
});
