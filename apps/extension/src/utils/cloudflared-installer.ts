import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { InstallStamp, VerifiedArtifact, type PinnedArtifact } from './verified-artifact';

/**
 * Exactly one pinned cloudflared release. The npm helper's `install()` resolves
 * `latest/download/`, which silently changes bytes under us; Ungate must know
 * up front which binary it is about to execute.
 */
export const CLOUDFLARED_VERSION = '2026.8.2';

const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

interface CloudflaredEntry {
	readonly file: string;
	readonly sha256: string;
	/** macOS assets are gzipped tarballs; every other platform ships a bare executable. */
	readonly archived: boolean;
}

interface CloudflaredArtifact extends PinnedArtifact {
	readonly archived: boolean;
}

/**
 * SHA-256 of the upstream release assets for {@link CLOUDFLARED_VERSION}.
 * Cloudflare ships macOS as a `.tgz` containing a single `cloudflared` entry and
 * every other platform as a bare executable. There is no Windows arm64 build, so
 * Windows on arm64 runs the amd64 executable under emulation — the same binary,
 * and therefore the same pinned digest, as Windows x64.
 */
const CLOUDFLARED_ARTIFACTS: Record<string, CloudflaredEntry> = {
	'darwin-arm64': {
		file: 'cloudflared-darwin-arm64.tgz',
		sha256: '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442',
		archived: true
	},
	'darwin-x64': {
		file: 'cloudflared-darwin-amd64.tgz',
		sha256: 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4',
		archived: true
	},
	'linux-arm64': {
		file: 'cloudflared-linux-arm64',
		sha256: '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790',
		archived: false
	},
	'linux-x64': {
		file: 'cloudflared-linux-amd64',
		sha256: 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2',
		archived: false
	},
	'win32-arm64': {
		file: 'cloudflared-windows-amd64.exe',
		sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
		archived: false
	},
	'win32-x64': {
		file: 'cloudflared-windows-amd64.exe',
		sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
		archived: false
	}
};

// Ungate refuses to execute a cloudflared it has not verified, and `resolveUserBinaryPath`
// ignores unstamped files, so telling the user to drop a binary into ~/.ungate/bin would be
// a lie. State the real consequence instead.
const UNSUPPORTED_REMEDY = `Ungate only runs a cloudflared build it can verify against a pinned SHA-256, and Cloudflare publishes no ${CLOUDFLARED_VERSION} build for this platform, so the built-in tunnel cannot start here. Run cloudflared yourself and give Cursor that tunnel URL.`;

export class CloudflaredInstaller {
	/**
	 * True when `binaryPath` was installed from the currently pinned artifact.
	 * Binaries left behind by the npm helper's `latest` install carry no stamp and
	 * are therefore reported as not current, so they get replaced rather than run.
	 */
	static isPinnedInstall(binaryPath: string): boolean {
		const artifact = this.getPinnedArtifact();

		return artifact !== null && fs.existsSync(binaryPath) && InstallStamp.matches(binaryPath, artifact);
	}

	/**
	 * Installs the pinned cloudflared release at `binaryPath` and returns it.
	 * Downloads into a staging directory, verifies the digest, and only then
	 * extracts, copies and marks the binary executable.
	 */
	static async install(binaryPath: string): Promise<string> {
		const artifact = this.getPinnedArtifact();

		if (!artifact) {
			throw VerifiedArtifact.unsupportedError(
				`cloudflared ${CLOUDFLARED_VERSION}`,
				`${process.platform}-${process.arch}`,
				Object.keys(CLOUDFLARED_ARTIFACTS),
				UNSUPPORTED_REMEDY
			);
		}

		const stagingRoot = path.join(os.tmpdir(), `ungate-cloudflared-${process.pid}-${Date.now()}`);
		const downloadPath = path.join(stagingRoot, artifact.url.slice(artifact.url.lastIndexOf('/') + 1));

		try {
			fs.mkdirSync(stagingRoot, { recursive: true });

			// Verified before extraction and before any chmod/copy of an executable.
			await VerifiedArtifact.download(artifact, downloadPath);

			const stagedBinary = artifact.archived ? this.extractTarball(downloadPath, stagingRoot) : downloadPath;

			fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
			fs.copyFileSync(stagedBinary, binaryPath);

			if (process.platform !== 'win32') {
				fs.chmodSync(binaryPath, 0o755);
			}

			InstallStamp.write(binaryPath, artifact);

			return binaryPath;
		} finally {
			fs.rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	private static getPinnedArtifact(): CloudflaredArtifact | null {
		const entry = CLOUDFLARED_ARTIFACTS[`${process.platform}-${process.arch}`];

		if (!entry) {
			return null;
		}

		return { url: `${RELEASE_BASE}/${entry.file}`, sha256: entry.sha256, archived: entry.archived };
	}

	private static extractTarball(tarballPath: string, stagingRoot: string): string {
		execFileSync('tar', ['-xzf', tarballPath, '-C', stagingRoot]);

		const extracted = path.join(stagingRoot, 'cloudflared');

		if (!fs.existsSync(extracted)) {
			throw new Error(`cloudflared ${CLOUDFLARED_VERSION} archive did not contain a cloudflared executable`);
		}

		return extracted;
	}
}
