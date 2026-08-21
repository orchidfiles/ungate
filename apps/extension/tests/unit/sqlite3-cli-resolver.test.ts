import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	return {
		execFileMock: vi.fn(),
		existsSyncMock: vi.fn(),
		fetchMock: vi.fn()
	};
});

vi.mock('node:child_process', () => {
	return {
		execFile: mocks.execFileMock
	};
});

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();

	return {
		...original,
		existsSync: mocks.existsSyncMock
	};
});

import { Sqlite3CliResolver } from '../../src/utils/sqlite3-cli-resolver';
import { InstallStamp, VerifiedArtifact, type PinnedArtifact } from '../../src/utils/verified-artifact';

const LINUX_X64_SHA256 = '9043648ac1186308c212c82d32327f0f1351fdf9dfb56a2a58bcf9bc947e3f90';
const LINUX_X64_URL = 'https://www.sqlite.org/2024/sqlite-tools-linux-x64-3470200.zip';

function forceHost(platform: string, arch: string): void {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

/** `which sqlite3` misses, so the resolver has to decide between a pinned download and failing closed. */
function mockEmptyPath(): void {
	mocks.execFileMock.mockImplementation((command: string, _args: string[], callback: (error: Error | null) => void) => {
		callback(new Error(`not found: ${command}`));
	});
}

describe('Sqlite3CliResolver', () => {
	const originalPlatform = process.platform;
	const originalArch = process.arch;

	beforeEach(() => {
		mocks.execFileMock.mockReset();
		mocks.existsSyncMock.mockReset();
		mocks.fetchMock.mockReset();
		vi.stubGlobal('fetch', mocks.fetchMock);
	});

	afterEach(() => {
		forceHost(originalPlatform, originalArch);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('returns the bundled install path when it was installed from the pinned archive', async () => {
		forceHost('linux', 'x64');
		mocks.existsSyncMock.mockImplementation((target) => String(target) === Sqlite3CliResolver.getInstalledPath());
		vi.spyOn(InstallStamp, 'matches').mockReturnValue(true);

		const resolved = await Sqlite3CliResolver.resolve();

		expect(resolved).toBe(Sqlite3CliResolver.getInstalledPath());
		expect(mocks.execFileMock).not.toHaveBeenCalled();
	});

	it('ignores an existing binary that carries no pinned checksum stamp', async () => {
		forceHost('linux', 'x64');
		mocks.existsSyncMock.mockImplementation((target) => {
			const value = String(target);

			return value === Sqlite3CliResolver.getInstalledPath() || value === '/usr/bin/sqlite3';
		});
		mocks.execFileMock.mockImplementation(
			(command: string, args: string[], callback: (error: Error | null, result?: { stdout: string }) => void) => {
				if (command === 'which' && args[0] === 'sqlite3') {
					callback(null, { stdout: '/usr/bin/sqlite3\n' });

					return;
				}

				callback(new Error('not found'));
			}
		);

		const resolved = await Sqlite3CliResolver.resolve();

		expect(resolved).toBe('/usr/bin/sqlite3');
		expect(mocks.fetchMock).not.toHaveBeenCalled();
	});

	it('falls back to sqlite3 from PATH before downloading', async () => {
		mocks.existsSyncMock.mockImplementation((target) => String(target) === '/usr/bin/sqlite3');
		mocks.execFileMock.mockImplementation(
			(command: string, args: string[], callback: (error: Error | null, result: { stdout: string }) => void) => {
				if (command === 'which' && args[0] === 'sqlite3') {
					callback(null, { stdout: '/usr/bin/sqlite3\n' });

					return;
				}

				callback(new Error('not found'), { stdout: '' });
			}
		);

		const resolved = await Sqlite3CliResolver.resolve();

		expect(resolved).toBe('/usr/bin/sqlite3');
		expect(mocks.fetchMock).not.toHaveBeenCalled();
	});

	it('uses where.exe on win32 when searching PATH', async () => {
		forceHost('win32', 'x64');
		mocks.existsSyncMock.mockImplementation((target) => String(target) === 'C:\\Tools\\sqlite3.exe');
		mocks.execFileMock.mockImplementation(
			(command: string, args: string[], callback: (error: Error | null, result: { stdout: string }) => void) => {
				if (command === 'where.exe' && args[0] === 'sqlite3') {
					callback(null, { stdout: 'C:\\Tools\\sqlite3.exe\r\n' });

					return;
				}

				callback(new Error('not found'), { stdout: '' });
			}
		);

		const resolved = await Sqlite3CliResolver.resolve();

		expect(resolved).toBe('C:\\Tools\\sqlite3.exe');
	});

	it('downloads the pinned archive into ~/.ungate/bin when nothing is available locally', async () => {
		forceHost('linux', 'x64');

		const installedPath = Sqlite3CliResolver.getInstalledPath();

		mocks.existsSyncMock.mockImplementation((target) => {
			const value = String(target);

			return value.startsWith(os.tmpdir()) && value.endsWith(`${path.sep}sqlite3`);
		});
		mocks.execFileMock.mockImplementation(
			(command: string, args: string[], callback: (error: Error | null, result?: { stdout: string }) => void) => {
				if (command === 'unzip') {
					const destDir = args[args.indexOf('-d') + 1];

					fs.mkdirSync(destDir, { recursive: true });
					fs.writeFileSync(path.join(destDir, 'sqlite3'), '');
					callback(null);

					return;
				}

				callback(new Error(`not found: ${command}`));
			}
		);

		const downloadSpy = vi
			.spyOn(VerifiedArtifact, 'download')
			.mockImplementation((_artifact: PinnedArtifact, destPath: string) => {
				fs.mkdirSync(path.dirname(destPath), { recursive: true });
				fs.writeFileSync(destPath, 'verified-zip');

				return Promise.resolve();
			});

		const resolved = await Sqlite3CliResolver.resolve();
		const artifact = downloadSpy.mock.calls[0]?.[0];

		fs.rmSync(installedPath, { force: true });
		fs.rmSync(`${installedPath}.sha256`, { force: true });

		expect(resolved).toBe(installedPath);
		expect(artifact?.url).toBe(LINUX_X64_URL);
		expect(artifact?.sha256).toBe(LINUX_X64_SHA256);
	});

	it('rejects a tampered archive before extraction and installs nothing', async () => {
		forceHost('linux', 'x64');
		mocks.existsSyncMock.mockReturnValue(false);
		mockEmptyPath();
		mocks.fetchMock.mockResolvedValue(new Response('tampered-sqlite-tools-zip'));

		const logs: string[] = [];
		const resolved = await Sqlite3CliResolver.resolve((message) => logs.push(message));

		expect(resolved).toBeNull();
		expect(logs.join('\n')).toMatch(/Checksum mismatch/);
		expect(mocks.execFileMock.mock.calls.some(([command]) => command === 'unzip')).toBe(false);
	});

	it('fails closed with an actionable message where upstream publishes no archive', async () => {
		forceHost('darwin', 'arm64');
		mocks.existsSyncMock.mockReturnValue(false);
		mockEmptyPath();

		const logs: string[] = [];
		const resolved = await Sqlite3CliResolver.resolve((message) => logs.push(message));
		const log = logs.join('\n');

		expect(resolved).toBeNull();
		expect(log).toContain('no pinned, checksum-verified artifact for darwin-arm64');
		expect(log).toContain('darwin-x64, linux-x64, win32-x64');
		expect(log).toContain('brew install sqlite');
		expect(mocks.fetchMock).not.toHaveBeenCalled();
	});
});
