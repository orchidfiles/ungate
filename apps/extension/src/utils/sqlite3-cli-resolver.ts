import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { InstallStamp, VerifiedArtifact, type PinnedArtifact } from './verified-artifact';

const execFileAsync = promisify(execFile);

const BIN_DIR = path.join(os.homedir(), '.ungate', 'bin');
const SQLITE_TOOLS_VERSION = '3470200';
const SQLITE_YEAR = '2024';

/**
 * SHA-256 of the exact sqlite.org release archives for {@link SQLITE_TOOLS_VERSION}.
 * sqlite.org publishes only these three tool bundles for 3.47.2 — there is no
 * macOS arm64 or Linux arm64 archive, so those hosts must supply their own CLI.
 * Regenerate by hashing the URLs below after bumping the version and year.
 */
const SQLITE_TOOLS_ARTIFACTS: Record<string, { readonly file: string; readonly sha256: string }> = {
	'darwin-x64': {
		file: `sqlite-tools-osx-x64-${SQLITE_TOOLS_VERSION}.zip`,
		sha256: '5f7d782ded38a56377eb34b38a8020e9c2c6f908109c904fe4e032f4a8ea54d0'
	},
	'linux-x64': {
		file: `sqlite-tools-linux-x64-${SQLITE_TOOLS_VERSION}.zip`,
		sha256: '9043648ac1186308c212c82d32327f0f1351fdf9dfb56a2a58bcf9bc947e3f90'
	},
	'win32-x64': {
		file: `sqlite-tools-win-x64-${SQLITE_TOOLS_VERSION}.zip`,
		sha256: '8c7fffbf4eec1f43e63153cca6deb018e4360d4d6b0d99bbdd2a541c53b7fa1c'
	}
};

const UNSUPPORTED_REMEDY =
	'Install the sqlite3 command-line tool yourself so it is discoverable on PATH (macOS: `brew install sqlite`, Debian/Ubuntu: `apt install sqlite3`).';

type InstallLogger = (message: string) => void;

export class Sqlite3CliResolver {
	static async resolve(onLog?: InstallLogger): Promise<string | null> {
		const artifact = this.getPinnedArtifact();
		const installedPath = this.getInstalledPath();

		if (artifact && fs.existsSync(installedPath) && InstallStamp.matches(installedPath, artifact)) {
			return installedPath;
		}

		const systemPath = await this.findOnPath();

		if (systemPath) {
			return systemPath;
		}

		if (!artifact) {
			onLog?.(
				VerifiedArtifact.unsupportedError(
					`SQLite CLI ${SQLITE_TOOLS_VERSION}`,
					`${process.platform}-${process.arch}`,
					Object.keys(SQLITE_TOOLS_ARTIFACTS),
					UNSUPPORTED_REMEDY
				).message
			);

			return null;
		}

		return this.downloadAndInstall(artifact, onLog);
	}

	static getBinaryName(): string {
		return process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3';
	}

	static getInstalledPath(): string {
		return path.join(BIN_DIR, this.getBinaryName());
	}

	private static async findOnPath(): Promise<string | null> {
		const commands =
			process.platform === 'win32'
				? [
						['where.exe', ['sqlite3']],
						['where', ['sqlite3']]
					]
				: [['which', ['sqlite3']]];

		for (const [command, args] of commands) {
			try {
				const { stdout } = await execFileAsync(command, args);
				const candidate = stdout.trim().split(/\r?\n/)[0];

				if (candidate && fs.existsSync(candidate)) {
					return candidate;
				}
			} catch {
				continue;
			}
		}

		return null;
	}

	/**
	 * Returns the pinned archive for the current host, or `null` when upstream
	 * publishes nothing for this platform/arch. A `null` result must never be
	 * turned into a download attempt.
	 */
	private static getPinnedArtifact(): PinnedArtifact | null {
		const entry = SQLITE_TOOLS_ARTIFACTS[`${process.platform}-${process.arch}`];

		if (!entry) {
			return null;
		}

		return {
			url: `https://www.sqlite.org/${SQLITE_YEAR}/${entry.file}`,
			sha256: entry.sha256
		};
	}

	private static async downloadAndInstall(artifact: PinnedArtifact, onLog?: InstallLogger): Promise<string | null> {
		const stagingRoot = path.join(os.tmpdir(), `ungate-sqlite3-${process.pid}-${Date.now()}`);
		const zipPath = path.join(stagingRoot, 'sqlite-tools.zip');
		const extractDir = path.join(stagingRoot, 'extracted');
		const installedPath = this.getInstalledPath();

		try {
			onLog?.('Downloading SQLite CLI...');
			fs.mkdirSync(extractDir, { recursive: true });

			// Verified before extraction: a tampered archive never reaches unzip.
			await VerifiedArtifact.download(artifact, zipPath);
			await this.extractZip(zipPath, extractDir);

			const extractedBinary = this.findExtractedBinary(extractDir);

			if (!extractedBinary) {
				throw new Error('sqlite3 binary was not found in the downloaded archive');
			}

			fs.mkdirSync(BIN_DIR, { recursive: true });
			fs.copyFileSync(extractedBinary, installedPath);

			if (process.platform !== 'win32') {
				fs.chmodSync(installedPath, 0o755);
			}

			InstallStamp.write(installedPath, artifact);
			onLog?.('SQLite CLI installed');

			return installedPath;
		} catch (error) {
			onLog?.(`Failed to install SQLite CLI: ${String(error)}`);

			return null;
		} finally {
			fs.rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	private static async extractZip(zipPath: string, destDir: string): Promise<void> {
		if (process.platform === 'win32') {
			await execFileAsync('powershell', [
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
			]);

			return;
		}

		await execFileAsync('unzip', ['-o', zipPath, '-d', destDir]);
	}

	private static findExtractedBinary(rootDir: string): string | null {
		const binaryName = this.getBinaryName();
		const directPath = path.join(rootDir, binaryName);

		if (fs.existsSync(directPath)) {
			return directPath;
		}

		for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
			const entryPath = path.join(rootDir, entry.name);

			if (entry.isFile() && entry.name === binaryName) {
				return entryPath;
			}

			if (entry.isDirectory()) {
				const nested = this.findExtractedBinary(entryPath);

				if (nested) {
					return nested;
				}
			}
		}

		return null;
	}
}
