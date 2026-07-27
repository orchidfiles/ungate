import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

import * as tar from 'tar';

import { RuntimeStateStore } from '../runtime-state';

import { CrossProcessLock } from './cross-process-lock';
import { NodeResolver } from './node-resolver';

const NATIVE_INSTALL_LOCK = 'native-install.lock';
const INSTALLED_BINARY_NAME = 'better_sqlite3.installed.node';
const execFile = promisify(cp.execFile);

interface InstallCallbacks {
	onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

export class BetterSqlite3Installer {
	static readBundledVersion(apiDir: string): string {
		const packagePath = path.join(apiDir, 'node_modules', 'better-sqlite3', 'package.json');
		const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };

		if (!pkg.version) {
			throw new Error('[native] better-sqlite3 package.json is missing version');
		}

		return pkg.version;
	}

	static getBinaryPath(apiDir: string): string {
		const sqliteDir = fs.realpathSync(path.join(apiDir, 'node_modules', 'better-sqlite3'));

		return path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
	}

	static getInstalledBinaryPath(apiDir: string): string {
		const binaryPath = this.getBinaryPath(apiDir);
		const installedBinaryPath = path.join(path.dirname(binaryPath), INSTALLED_BINARY_NAME);

		return installedBinaryPath;
	}

	static resolveBindingPath(apiDir: string): string {
		const installed = this.getInstalledBinaryPath(apiDir);
		if (fs.existsSync(installed)) return installed;

		return this.getBinaryPath(apiDir);
	}

	static async ensureInstalled(apiDir: string, runtime: string, callbacks: InstallCallbacks): Promise<void> {
		if (RuntimeStateStore.isApiStartSuppressed()) {
			const runtimeState = RuntimeStateStore.read();
			throw new Error(runtimeState.api.lastError ?? '[native] better-sqlite3 prebuilt installation failed');
		}

		const isAlreadyLoadable = await this.canLoad(runtime, apiDir, callbacks);

		if (isAlreadyLoadable) {
			return;
		}

		const release = await CrossProcessLock.acquire(NATIVE_INSTALL_LOCK);

		try {
			const becameLoadableWhileWaiting = await this.canLoad(runtime, apiDir, callbacks);

			if (becameLoadableWhileWaiting) {
				return;
			}

			await this.install(apiDir, runtime, callbacks);
		} finally {
			release();
		}

		const isLoadableAfterInstall = await this.canLoad(runtime, apiDir, callbacks);

		if (!isLoadableAfterInstall) {
			const message = '[native] better-sqlite3 prebuilt installation failed';

			await RuntimeStateStore.suppressApiAutoStart(message);
			throw new Error(message);
		}
	}

	private static async install(apiDir: string, runtime: string, callbacks: InstallCallbacks): Promise<void> {
		const binaryPath = this.getBinaryPath(apiDir);
		const installedBinaryPath = this.getInstalledBinaryPath(apiDir);
		const version = this.readBundledVersion(apiDir);
		const info = NodeResolver.inspect(runtime);
		const tarName = `better-sqlite3-v${version}-node-v${info.abi}-${info.platform}-${info.arch}.tar.gz`;
		const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${tarName}`;

		callbacks.onLog('info', `[native] Using runtime: ${runtime}`);
		callbacks.onLog('info', `[native] Downloading ${tarName}...`);

		const stagingRoot = path.join(os.tmpdir(), `ungate-better-sqlite3-${process.pid}-${Date.now()}`);

		try {
			fs.mkdirSync(stagingRoot, { recursive: true });
			await this.downloadAndExtract(url, stagingRoot);
			const stagedBinary = path.join(stagingRoot, 'build', 'Release', 'better_sqlite3.node');

			if (!fs.existsSync(stagedBinary)) {
				throw new Error('[native] Downloaded archive did not contain better_sqlite3.node');
			}

			fs.mkdirSync(path.dirname(binaryPath), { recursive: true });

			const tempTarget = `${installedBinaryPath}.${process.pid}.tmp`;

			fs.copyFileSync(stagedBinary, tempTarget);
			fs.renameSync(tempTarget, installedBinaryPath);
			callbacks.onLog('info', '[native] better-sqlite3 binary installed');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			if (message.includes('HTTP 404')) {
				callbacks.onLog('error', `[native] No prebuilt binary for ABI ${info.abi}`);
				throw new Error(`[native] No prebuilt better-sqlite3 binary for Node ABI ${info.abi} (${info.platform}-${info.arch}).`);
			}

			callbacks.onLog('error', `[native] Prebuilt install failed: ${message}`);
			throw err;
		} finally {
			fs.rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	private static async downloadAndExtract(url: string, extractDir: string): Promise<void> {
		const response = await fetch(url, {
			headers: { 'User-Agent': 'ungate-extension' }
		});

		if (!response.ok) {
			throw new Error(`Download failed: HTTP ${response.status}`);
		}

		if (!response.body) {
			throw new Error('Download failed: empty response body');
		}

		// tar types are loose in CJS; runtime extract is validated by canLoad().
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
		await pipeline(Readable.fromWeb(response.body), createGunzip(), tar.extract({ cwd: extractDir }));
	}

	private static async canLoad(runtime: string, apiDir: string, callbacks: InstallCallbacks): Promise<boolean> {
		const pathsToTry: string[] = [];
		const installedBinaryPath = this.getInstalledBinaryPath(apiDir);
		const defaultBinaryPath = this.getBinaryPath(apiDir);

		if (fs.existsSync(installedBinaryPath)) {
			pathsToTry.push(installedBinaryPath);
		}

		if (fs.existsSync(defaultBinaryPath) && defaultBinaryPath !== installedBinaryPath) {
			pathsToTry.push(defaultBinaryPath);
		}

		for (const bindingPath of pathsToTry) {
			const isLoadable = await this.tryLoad(runtime, apiDir, bindingPath, callbacks);

			if (isLoadable) {
				return true;
			}
		}

		return false;
	}

	private static async tryLoad(
		runtime: string,
		apiDir: string,
		bindingPath: string,
		callbacks: InstallCallbacks
	): Promise<boolean> {
		const bindingLiteral = JSON.stringify(bindingPath);
		const script = `const Database=require('better-sqlite3'); const db=new Database(':memory:', { nativeBinding: ${bindingLiteral} }); db.pragma('journal_mode = WAL'); db.close();`;

		try {
			await execFile(runtime, ['-e', script], { cwd: apiDir });

			return true;
		} catch (error) {
			const stderrRaw = error instanceof Error && 'stderr' in error ? error.stderr : '';
			const stderr = typeof stderrRaw === 'string' ? stderrRaw.trim() : '';

			if (stderr) {
				callbacks.onLog('warn', `[native] ${stderr}`);
			}

			return false;
		}
	}
}
