import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PINNED_VERSION = '12.11.1';
const WIN32_X64_ABI137_SHA256 = '4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255';

/** Staging directory prefix used by BetterSqlite3Installer.install for the extracted archive. */
const STAGING_PREFIX = 'ungate-better-sqlite3-';

/** Serves the pinned checksum stamp for `<binary>.sha256` and the bundled package.json otherwise. */
function readStampedFile(target: unknown): string {
	if (String(target).endsWith('.sha256')) {
		return WIN32_X64_ABI137_SHA256;
	}

	return JSON.stringify({ version: PINNED_VERSION });
}

const execFileMock = vi.fn();
const existsSyncMock = vi.fn();
const fetchMock = vi.fn();
const copyFileSyncMock = vi.fn();
const renameSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const readFileSyncMock = vi.fn(readStampedFile);
const inspectMock = vi.fn(() => {
	return { abi: '137', platform: 'win32', arch: 'x64' };
});

vi.mock('node:child_process', () => {
	return {
		execFile: (...args: unknown[]) => execFileMock(...args)
	};
});

vi.mock('node:fs', () => {
	return {
		existsSync: (...args: unknown[]) => existsSyncMock(...args),
		readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
		realpathSync: vi.fn((target: string) => target),
		mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
		copyFileSync: (...args: unknown[]) => copyFileSyncMock(...args),
		rmSync: (...args: unknown[]) => rmSyncMock(...args),
		renameSync: (...args: unknown[]) => renameSyncMock(...args),
		writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args)
	};
});

vi.mock('../../src/utils/cross-process-lock', () => {
	return {
		CrossProcessLock: {
			acquire: vi.fn(() => Promise.resolve(() => {}))
		}
	};
});

vi.mock('../../src/utils/node-resolver', () => {
	return {
		NodeResolver: {
			inspect: (...args: unknown[]) => inspectMock(...args)
		}
	};
});

const isApiStartSuppressedMock = vi.fn<() => boolean>(() => false);
const suppressApiAutoStartMock = vi.fn<() => Promise<void>>(() => Promise.resolve());

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			read: vi.fn(() => {
				return {
					api: {
						status: 'error',
						lastError: '[native] better-sqlite3 prebuilt installation failed'
					}
				};
			}),
			isApiStartSuppressed: (...args: unknown[]) => isApiStartSuppressedMock(...args),
			suppressApiAutoStart: (...args: unknown[]) => suppressApiAutoStartMock(...args)
		}
	};
});

import { BetterSqlite3Installer } from '../../src/utils/better-sqlite3-installer';
import { VerifiedArtifact, type PinnedArtifact } from '../../src/utils/verified-artifact';

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

function mockExecFileSuccess(): void {
	execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
		callback(null, { stdout: '', stderr: '' });
	});
}

function mockExecFileFailure(): void {
	execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
		const error = new Error('load failed') as Error & { stderr?: string };
		error.stderr = '';
		callback(error, { stdout: '', stderr: '' });
	});
}

/** Archive extraction is a private static; spying on it keeps the test off the filesystem. */
function privateApi(): { extractArchive(archivePath: string, extractDir: string): Promise<void> } {
	return BetterSqlite3Installer as unknown as { extractArchive(archivePath: string, extractDir: string): Promise<void> };
}

describe('BetterSqlite3Installer', () => {
	beforeEach(() => {
		isApiStartSuppressedMock.mockReset();
		isApiStartSuppressedMock.mockReturnValue(false);
		suppressApiAutoStartMock.mockReset();
		execFileMock.mockReset();
		existsSyncMock.mockReset();
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
		copyFileSyncMock.mockReset();
		renameSyncMock.mockReset();
		rmSyncMock.mockReset();
		mkdirSyncMock.mockReset();
		writeFileSyncMock.mockReset();
		readFileSyncMock.mockReset();
		readFileSyncMock.mockImplementation(readStampedFile);
		inspectMock.mockReset();
		inspectMock.mockReturnValue({ abi: '137', platform: 'win32', arch: 'x64' });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('skips download when a pin-stamped installed native binary already loads', async () => {
		mockExecFileSuccess();
		existsSyncMock.mockImplementation((target) => String(target).endsWith('better_sqlite3.installed.node'));

		await BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(execFileMock).toHaveBeenCalledTimes(1);

		const execArgs = execFileMock.mock.calls[0]?.[1];
		const script = Array.isArray(execArgs) ? String(execArgs[1]) : '';

		expect(script).toContain('nativeBinding');
		expect(script).toContain('better_sqlite3.installed.node');
	});

	it('ignores an unstamped legacy managed binary and probes the bundled binding instead', async () => {
		mockExecFileSuccess();
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockImplementation((target: unknown) => {
			if (String(target).endsWith('.sha256')) {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}

			return JSON.stringify({ version: PINNED_VERSION });
		});

		await BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() });

		const probedScripts = execFileMock.mock.calls.map(([, args]) => (Array.isArray(args) ? String(args[1]) : ''));

		expect(probedScripts).toHaveLength(1);
		expect(probedScripts[0]).not.toContain('better_sqlite3.installed.node');
		expect(probedScripts[0]).toContain('build/Release/better_sqlite3.node');
	});

	it('replaces a managed binary whose stamp is not a pinned digest, then stamps the verified one', async () => {
		let stamp = 'deadbeef'.repeat(8);

		mockExecFileSuccess();
		existsSyncMock.mockImplementation((target) => {
			const value = String(target);

			// The managed binary exists (with a foreign stamp) and so does the extracted
			// staging binary; the bundled default binding does not, so canLoad has nothing
			// trustworthy to probe and install has to run.
			return value.endsWith('better_sqlite3.installed.node') || value.includes(STAGING_PREFIX);
		});
		readFileSyncMock.mockImplementation((target: unknown) =>
			String(target).endsWith('.sha256') ? stamp : JSON.stringify({ version: PINNED_VERSION })
		);
		writeFileSyncMock.mockImplementation((target: unknown, data: unknown) => {
			if (String(target).endsWith('.sha256')) {
				stamp = String(data);
			}
		});

		const downloadSpy = vi.spyOn(VerifiedArtifact, 'download').mockResolvedValue(undefined);

		vi.spyOn(privateApi(), 'extractArchive').mockResolvedValue(undefined);

		await BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() });

		expect(downloadSpy).toHaveBeenCalledTimes(1);
		expect(writeFileSyncMock).toHaveBeenCalledWith(
			expect.stringContaining('better_sqlite3.installed.node.sha256'),
			WIN32_X64_ABI137_SHA256,
			'utf8'
		);
		expect(stamp).toBe(WIN32_X64_ABI137_SHA256);
	});

	it('hands the API child the managed binding only once it carries a pinned stamp', () => {
		existsSyncMock.mockReturnValue(true);

		expect(BetterSqlite3Installer.resolveBindingPath('/tmp/ungate-api')).toContain('better_sqlite3.installed.node');

		readFileSyncMock.mockImplementation((target: unknown) => {
			if (String(target).endsWith('.sha256')) {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}

			return JSON.stringify({ version: PINNED_VERSION });
		});

		const fallback = BetterSqlite3Installer.resolveBindingPath('/tmp/ungate-api');

		expect(fallback).toContain('better_sqlite3.node');
		expect(fallback).not.toContain('better_sqlite3.installed.node');
	});

	it('does not call https when a concurrent install already made the binary loadable', async () => {
		execFileMock
			.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				const error = new Error('load failed') as Error & { stderr?: string };
				error.stderr = '';
				callback(error, { stdout: '', stderr: '' });
			})
			.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				callback(null, { stdout: '', stderr: '' });
			})
			.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				callback(null, { stdout: '', stderr: '' });
			});

		existsSyncMock.mockReturnValue(true);

		await BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() });

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not retry install after a shared native install failure was recorded', async () => {
		isApiStartSuppressedMock.mockReturnValue(true);

		await expect(BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() })).rejects.toThrow(
			'[native] better-sqlite3 prebuilt installation failed'
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('installs the pinned prebuild matching the host ABI tuple', async () => {
		execFileMock
			.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				const error = new Error('load failed') as Error & { stderr?: string };
				error.stderr = '';
				callback(error, { stdout: '', stderr: '' });
			})
			.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				const error = new Error('load failed') as Error & { stderr?: string };
				error.stderr = '';
				callback(error, { stdout: '', stderr: '' });
			})
			.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
				callback(null, { stdout: '', stderr: '' });
			});
		existsSyncMock.mockImplementation((target) => {
			if (String(target).endsWith('better_sqlite3.installed.node')) {
				return false;
			}

			if (String(target).endsWith('build/Release/better_sqlite3.node')) {
				return true;
			}

			return false;
		});

		const downloadSpy = vi.spyOn(VerifiedArtifact, 'download').mockResolvedValue(undefined);

		vi.spyOn(privateApi(), 'extractArchive').mockResolvedValue(undefined);

		await BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() });

		const artifact = downloadSpy.mock.calls[0]?.[0] as PinnedArtifact | undefined;

		expect(artifact?.url).toBe(
			`https://github.com/WiseLibs/better-sqlite3/releases/download/v${PINNED_VERSION}/better-sqlite3-v${PINNED_VERSION}-node-v137-win32-x64.tar.gz`
		);
		expect(artifact?.sha256).toBe(WIN32_X64_ABI137_SHA256);
		expect(renameSyncMock).toHaveBeenCalledWith(
			expect.stringContaining('better_sqlite3.installed.node'),
			expect.stringContaining('better_sqlite3.installed.node')
		);
	});

	it('fails closed for an ABI tuple that has no pinned checksum', async () => {
		mockExecFileFailure();
		existsSyncMock.mockReturnValue(true);
		inspectMock.mockReturnValue({ abi: '115', platform: 'linux', arch: 'x64' });

		const downloadSpy = vi.spyOn(VerifiedArtifact, 'download');

		await expect(BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() })).rejects.toThrow(
			/no pinned, checksum-verified artifact for node-v115-linux-x64/
		);

		expect(downloadSpy).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fails closed for a musl-only tuple that shares process.platform with glibc', async () => {
		mockExecFileFailure();
		existsSyncMock.mockReturnValue(true);
		inspectMock.mockReturnValue({ abi: '137', platform: 'linuxmusl', arch: 'x64' });

		await expect(BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() })).rejects.toThrow(
			/no pinned, checksum-verified artifact for node-v137-linuxmusl-x64/
		);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses to install when the bundled version drifts from the pinned checksums', async () => {
		mockExecFileFailure();
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReturnValue(JSON.stringify({ version: '12.12.0' }));

		const downloadSpy = vi.spyOn(VerifiedArtifact, 'download');

		await expect(BetterSqlite3Installer.ensureInstalled('/tmp/ungate-api', 'node', { onLog: vi.fn() })).rejects.toThrow(
			`[native] better-sqlite3 12.12.0 is bundled but only ${PINNED_VERSION} has pinned checksums`
		);

		expect(downloadSpy).not.toHaveBeenCalled();
	});
});
