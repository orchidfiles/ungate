import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

import * as tar from 'tar';

import { RuntimeStateStore } from '../runtime-state';

import { CrossProcessLock } from './cross-process-lock';
import { NodeResolver } from './node-resolver';
import { InstallStamp, VerifiedArtifact, type PinnedArtifact } from './verified-artifact';

const NATIVE_INSTALL_LOCK = 'native-install.lock';
const INSTALLED_BINARY_NAME = 'better_sqlite3.installed.node';
const execFile = promisify(cp.execFile);

const PINNED_VERSION = '12.11.1';
const RELEASE_BASE = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${PINNED_VERSION}`;

/**
 * SHA-256 of every WiseLibs prebuild this extension is allowed to install, taken
 * from the immutable v12.11.1 release assets. Node ABI 127 = Node 22,
 * 137 = Node 24, 141 = Node 25, 147 = Node 26 (nodejs/node abi_version_registry).
 * Tuples missing from this table fail closed instead of being fetched:
 * musl Linux, 32-bit and Electron ABIs are deliberately absent because
 * `process.platform` cannot distinguish them from the entries below.
 */
const PREBUILT_SHA256: Record<string, string> = {
	'node-v127-darwin-arm64': '8855551fa9a93d7141c5ff2156dd418bde42f63c23255b309a5b29c7c77925e2',
	'node-v127-darwin-x64': '9c76d0dd927ad83941d29ba9cd3a4f507a88c14057afa0a3e0dbe93b5e251f4d',
	'node-v127-linux-arm64': '00f8035f4322c14ab4dbb3ee6f4b6c9ca25209fe2a77ac2759cd09dd42587d48',
	'node-v127-linux-x64': '94ce113ea2d9347fcd1cf8e46445cc271d1dbd02d05a64aa460442222f023b11',
	'node-v127-win32-arm64': '895af65f470351e6252b03249dbea123f3246175471c3f59801b87a22e6ed5bf',
	'node-v127-win32-x64': '927b34496e946dc7c9a45636a03a039df72f10191ccc4960b8616d1a9319e45b',
	'node-v137-darwin-arm64': '6eaefc8a9c088fea873365f7db2c0f89be6ea021ede62f6a71832f5130826a93',
	'node-v137-darwin-x64': 'f9fe570a2ef7d6069196dd595f49bc8592574963dd1f249dcaa8878626773fc9',
	'node-v137-linux-arm64': '60da4cbe1b1714c8db62f2ee71a9928cde5303dab57bde14c02debd12a784439',
	'node-v137-linux-x64': '99c43785639d5d3690c396ba245ee680ac8b469a46b19233a3546f0eb7f8e312',
	'node-v137-win32-arm64': 'a6d712a918ece580882f83aee8c02d37c8841036eef68d208d71eb255d041e80',
	'node-v137-win32-x64': '4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255',
	'node-v141-darwin-arm64': 'e5a528210e820667d0c00d72db88c54f49b651e0b2861c349efba1d7d35b5cd5',
	'node-v141-darwin-x64': '27e8e4f4ccbd476271f607866cdbf1555fb75d7b35bc997520eb93da7c40ce50',
	'node-v141-linux-arm64': 'a5c37512a904e88bda3ffa1d28c8fbbfa79eb786e95c2e0a6309d55377fa0135',
	'node-v141-linux-x64': '6c9e172375f9fb73b6adcc59057e257a36cbea77a8ea337f41561f73949339a1',
	'node-v141-win32-arm64': 'd472ea8b36ecf195e47bbcb70185bf3c3798ff0dde6ba211f8e884eb4768f3f5',
	'node-v141-win32-x64': 'c3a1e9556bca6a517cc0b524a51585e648f2982fdff78c6bcb0b267f778238aa',
	'node-v147-darwin-arm64': '449dc1a8d6faf652fd449a19af125746f45c0f0abb1a5d17ec9fd44e8f5e7e69',
	'node-v147-darwin-x64': 'a2ecaf018ac3648dc752efa4a97de098d4d24b2425731c897de94ca1e8ae0b0e',
	'node-v147-linux-arm64': 'e277fc5bae5847d54351b12f907e9b6929c8f2c5c0660520ae4632b4806ee6f8',
	'node-v147-linux-x64': 'a90711eae785b646d6799b31cf8dd79a5d750b1af72d310472c3b996c5cee92d',
	'node-v147-win32-arm64': '65f177370ca2b4917501686b295f977585977a1276cc69898a50744dadb282d2',
	'node-v147-win32-x64': 'ff6d04d52e1625d4fbf4b7a62e4f282366953be40016ded4815a651b2160bff8'
};

interface InstallCallbacks {
	onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * The parts of a resolved Node runtime that decide which prebuild applies. Kept
 * structural on purpose: `NodeResolver.inspect` reports exactly these fields, and
 * matching them here keeps the pinned-artifact lookup independent of that module.
 */
interface RuntimeTarget {
	readonly abi: string;
	readonly platform: string;
	readonly arch: string;
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

	/**
	 * The binding path handed to the API child. The managed binary is only offered
	 * once it carries a pinned checksum stamp, so a legacy `better_sqlite3.installed.node`
	 * left by a pre-pinning Ungate is never loaded.
	 */
	static resolveBindingPath(apiDir: string): string {
		const installed = this.getInstalledBinaryPath(apiDir);

		if (this.isVerifiedManagedBinary(installed)) {
			return installed;
		}

		return this.getBinaryPath(apiDir);
	}

	/**
	 * True when the file was written by a verified install of one of the pinned
	 * prebuilds. Absent or foreign stamps mean the bytes were never checked, so the
	 * binary must be replaced rather than executed. ABI correctness is enforced
	 * separately by the load probe in {@link canLoad}.
	 */
	static isVerifiedManagedBinary(installedBinaryPath: string): boolean {
		if (!fs.existsSync(installedBinaryPath)) {
			return false;
		}

		const digest = InstallStamp.read(installedBinaryPath);

		return digest !== null && Object.values(PREBUILT_SHA256).includes(digest);
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
		const info = NodeResolver.inspect(runtime);
		const artifact = this.getPinnedArtifact(apiDir, info);
		const tarName = artifact.url.slice(artifact.url.lastIndexOf('/') + 1);

		callbacks.onLog('info', `[native] Using runtime: ${runtime}`);
		callbacks.onLog('info', `[native] Downloading ${tarName}...`);

		const stagingRoot = path.join(os.tmpdir(), `ungate-better-sqlite3-${process.pid}-${Date.now()}`);
		const archivePath = path.join(stagingRoot, tarName);
		const extractDir = path.join(stagingRoot, 'extracted');

		try {
			fs.mkdirSync(extractDir, { recursive: true });

			// Verified before extraction: a tampered archive never reaches tar.
			await VerifiedArtifact.download(artifact, archivePath);
			await this.extractArchive(archivePath, extractDir);

			const stagedBinary = path.join(extractDir, 'build', 'Release', 'better_sqlite3.node');

			if (!fs.existsSync(stagedBinary)) {
				throw new Error('[native] Downloaded archive did not contain better_sqlite3.node');
			}

			fs.mkdirSync(path.dirname(binaryPath), { recursive: true });

			const tempTarget = `${installedBinaryPath}.${process.pid}.tmp`;

			fs.copyFileSync(stagedBinary, tempTarget);
			fs.renameSync(tempTarget, installedBinaryPath);
			InstallStamp.write(installedBinaryPath, artifact);
			callbacks.onLog('info', `[native] better-sqlite3 binary installed (sha256 ${artifact.sha256})`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			callbacks.onLog('error', `[native] Prebuilt install failed: ${message}`);
			throw err;
		} finally {
			fs.rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	/**
	 * Resolves the single pinned prebuild for this runtime. Throws — never falls
	 * back to an unpinned URL — when the bundled version drifts from the pinned
	 * checksum set or the host ABI/platform/arch tuple has no entry.
	 */
	private static getPinnedArtifact(apiDir: string, info: RuntimeTarget): PinnedArtifact {
		const version = this.readBundledVersion(apiDir);

		if (version !== PINNED_VERSION) {
			throw new Error(
				`[native] better-sqlite3 ${version} is bundled but only ${PINNED_VERSION} has pinned checksums. ` +
					'Refresh PREBUILT_SHA256 from the upstream release assets before bumping the dependency.'
			);
		}

		const tuple = `node-v${info.abi}-${info.platform}-${info.arch}`;
		const sha256 = PREBUILT_SHA256[tuple];

		if (!sha256) {
			throw VerifiedArtifact.unsupportedError(
				`[native] better-sqlite3 ${PINNED_VERSION}`,
				tuple,
				Object.keys(PREBUILT_SHA256),
				'Point Ungate at a Node 22, 24, 25 or 26 runtime on glibc Linux, macOS or Windows.'
			);
		}

		return { url: `${RELEASE_BASE}/better-sqlite3-v${PINNED_VERSION}-${tuple}.tar.gz`, sha256 };
	}

	private static async extractArchive(archivePath: string, extractDir: string): Promise<void> {
		// tar types are loose in CJS; runtime extract is validated by canLoad().
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
		await pipeline(fs.createReadStream(archivePath), createGunzip(), tar.extract({ cwd: extractDir }));
	}

	private static async canLoad(runtime: string, apiDir: string, callbacks: InstallCallbacks): Promise<boolean> {
		const pathsToTry: string[] = [];
		const installedBinaryPath = this.getInstalledBinaryPath(apiDir);
		const defaultBinaryPath = this.getBinaryPath(apiDir);

		// A managed binary without a pinned stamp predates checksum verification.
		if (this.isVerifiedManagedBinary(installedBinaryPath)) {
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
