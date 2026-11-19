import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { InstallStamp, VerifiedArtifact, type PinnedArtifact } from './verified-artifact';
import { ZipExtractor } from './zip-extractor';

/**
 * Exactly one pinned ngrok agent. The `stable` download URLs silently change
 * bytes under us; Ungate must know up front which binary it is about to execute.
 */
export const NGROK_VERSION = '3.39.13';

interface NgrokEntry {
	readonly url: string;
	readonly sha256: string;
	/** Windows assets are zips containing `ngrok.exe`; every other platform ships a bare executable. */
	readonly archived: boolean;
}

interface NgrokArtifact extends PinnedArtifact {
	readonly archived: boolean;
}

/**
 * SHA-256 of the upstream release assets for {@link NGROK_VERSION}.
 * ngrok ships Windows as a zip containing `ngrok.exe` and every other platform as a bare
 * executable. There is no Windows arm64 build, so Windows on arm64 runs the amd64 executable
 * under emulation — the same binary, and therefore the same pinned digest, as Windows x64.
 * Unix digests are of the bare binaries published for this version; the Windows digest is of
 * the zip ngrok's own Chocolatey package pins.
 */
const NGROK_ARTIFACTS: Record<string, NgrokEntry> = {
	'darwin-arm64': {
		url: 'https://bin.ngrok.com/a/aRfC2Kft1Jc/ngrok-v3-3.39.13-darwin-arm64',
		sha256: '686c32f1d6aff864eb2f221dedc97302d7b1cf863c6b71e57eb8010d65284321',
		archived: false
	},
	'linux-arm64': {
		url: 'https://bin.ngrok.com/a/gNfeve1VDdJ/ngrok-v3-3.39.13-linux-arm64',
		sha256: 'b9512bdbecfc149510f5f0bcd18d7a06d033d7e2a371f76b37cd55b44f03e5b5',
		archived: false
	},
	'linux-x64': {
		url: 'https://bin.ngrok.com/a/2u8ZAPuZnnL/ngrok-v3-3.39.13-linux-amd64',
		sha256: '4399384bf4d6a5ad65136770a931536db9e97911f52686e3419dc434a74df75f',
		archived: false
	},
	'win32-arm64': {
		url: 'https://bin.ngrok.com/a/VUnfuMhAnU/ngrok-v3-3.39.13-windows-amd64.zip',
		sha256: '438bad3dbefd7e244be9dfae3889dcf99073b515845b66ab5617e4887bc24636',
		archived: true
	},
	'win32-x64': {
		url: 'https://bin.ngrok.com/a/VUnfuMhAnU/ngrok-v3-3.39.13-windows-amd64.zip',
		sha256: '438bad3dbefd7e244be9dfae3889dcf99073b515845b66ab5617e4887bc24636',
		archived: true
	}
};

// ngrok publishes no darwin-x64 or linux-ia32 build of this version, and Ungate refuses to
// execute an unstamped binary, so there is no manual drop-in. State the real consequence.
const UNSUPPORTED_REMEDY = `Ungate only runs an ngrok build it can verify against a pinned SHA-256, and ngrok publishes no ${NGROK_VERSION} build for this platform, so the ngrok tunnel cannot start here. Keep the quick tunnel, or run ngrok yourself and give Cursor that tunnel URL.`;

export class NgrokInstaller {
	/**
	 * True when `binaryPath` was installed from the currently pinned artifact.
	 * A binary left behind by an older Ungate carries no matching stamp and is
	 * therefore reported as not current, so it gets replaced rather than run.
	 */
	static isPinnedInstall(binaryPath: string): boolean {
		const artifact = this.getPinnedArtifact();

		return artifact !== null && fs.existsSync(binaryPath) && InstallStamp.matches(binaryPath, artifact);
	}

	/**
	 * Installs the pinned ngrok release at `binaryPath` and returns it.
	 * Downloads into a staging directory, verifies the digest, and only then
	 * extracts, copies and marks the binary executable.
	 */
	static async install(binaryPath: string): Promise<string> {
		const artifact = this.getPinnedArtifact();

		if (!artifact) {
			throw VerifiedArtifact.unsupportedError(
				`ngrok ${NGROK_VERSION}`,
				`${process.platform}-${process.arch}`,
				Object.keys(NGROK_ARTIFACTS),
				UNSUPPORTED_REMEDY
			);
		}

		const stagingRoot = path.join(os.tmpdir(), `ungate-ngrok-${process.pid}-${Date.now()}`);
		const downloadPath = path.join(stagingRoot, artifact.url.slice(artifact.url.lastIndexOf('/') + 1));

		try {
			fs.mkdirSync(stagingRoot, { recursive: true });

			// Verified before extraction and before any chmod/copy of an executable.
			await VerifiedArtifact.download(artifact, downloadPath);

			const stagedBinary = artifact.archived ? await this.extractZip(downloadPath, stagingRoot) : downloadPath;

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

	private static getPinnedArtifact(): NgrokArtifact | null {
		const entry = NGROK_ARTIFACTS[`${process.platform}-${process.arch}`];

		if (!entry) {
			return null;
		}

		return { url: entry.url, sha256: entry.sha256, archived: entry.archived };
	}

	private static async extractZip(zipPath: string, stagingRoot: string): Promise<string> {
		const extractDir = path.join(stagingRoot, 'extracted');

		fs.mkdirSync(extractDir, { recursive: true });
		await ZipExtractor.extract(zipPath, extractDir);

		const extracted = path.join(extractDir, 'ngrok.exe');

		if (!fs.existsSync(extracted)) {
			throw new Error(`ngrok ${NGROK_VERSION} archive did not contain ngrok.exe`);
		}

		return extracted;
	}
}
