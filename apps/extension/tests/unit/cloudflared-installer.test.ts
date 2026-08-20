import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CLOUDFLARED_VERSION, CloudflaredInstaller } from '../../src/utils/cloudflared-installer';
import { InstallStamp, VerifiedArtifact, type PinnedArtifact } from '../../src/utils/verified-artifact';

const LINUX_X64_SHA256 = 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2';

function forceHost(platform: string, arch: string): void {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

describe('CloudflaredInstaller', () => {
	const originalPlatform = process.platform;
	const originalArch = process.arch;
	let binDir: string;
	let fetchMock: Mock;

	beforeEach(() => {
		binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-cloudflared-'));
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		forceHost(originalPlatform, originalArch);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		fs.rmSync(binDir, { recursive: true, force: true });
	});

	it('installs, marks executable and stamps the pinned artifact', async () => {
		forceHost('linux', 'x64');

		const downloadSpy = vi
			.spyOn(VerifiedArtifact, 'download')
			.mockImplementation((_artifact: PinnedArtifact, destPath: string) => {
				fs.mkdirSync(path.dirname(destPath), { recursive: true });
				fs.writeFileSync(destPath, 'verified-cloudflared');

				return Promise.resolve();
			});

		const binaryPath = path.join(binDir, 'cloudflared');
		const installed = await CloudflaredInstaller.install(binaryPath);

		expect(installed).toBe(binaryPath);
		expect(fs.readFileSync(binaryPath, 'utf8')).toBe('verified-cloudflared');
		expect(fs.statSync(binaryPath).mode & 0o777).toBe(0o755);
		expect(fs.readFileSync(`${binaryPath}.sha256`, 'utf8')).toBe(LINUX_X64_SHA256);
		expect(CloudflaredInstaller.isPinnedInstall(binaryPath)).toBe(true);

		const artifact = downloadSpy.mock.calls[0]?.[0];

		expect(artifact?.url).toBe(
			`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`
		);
		expect(artifact?.sha256).toBe(LINUX_X64_SHA256);
	});

	it('rejects a tampered download without leaving an executable behind', async () => {
		forceHost('linux', 'x64');
		fetchMock.mockResolvedValue(new Response('tampered-cloudflared'));

		const binaryPath = path.join(binDir, 'cloudflared');

		await expect(CloudflaredInstaller.install(binaryPath)).rejects.toThrow(/Checksum mismatch/);

		expect(fs.existsSync(binaryPath)).toBe(false);
		expect(fs.existsSync(`${binaryPath}.sha256`)).toBe(false);
	});

	it('fails closed on an unsupported platform without downloading anything', async () => {
		forceHost('sunos', 'x64');

		let message = '';

		try {
			await CloudflaredInstaller.install(path.join(binDir, 'cloudflared'));
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain('no pinned, checksum-verified artifact for sunos-x64');
		expect(message).toContain('the built-in tunnel cannot start here');
		// The remedy must not promise a manual drop-in: resolveUserBinaryPath rejects unstamped files.
		expect(message).not.toContain('place it in ~/.ungate/bin');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ignores a binary left behind by an unverified latest install', () => {
		forceHost('linux', 'x64');

		const binaryPath = path.join(binDir, 'cloudflared');

		fs.writeFileSync(binaryPath, 'binary from an unpinned latest download');

		expect(CloudflaredInstaller.isPinnedInstall(binaryPath)).toBe(false);

		InstallStamp.write(binaryPath, { url: 'https://example.invalid/cloudflared', sha256: LINUX_X64_SHA256 });

		expect(CloudflaredInstaller.isPinnedInstall(binaryPath)).toBe(true);
	});

	it('reports no pinned install on platforms with no pinned artifact', () => {
		forceHost('sunos', 'x64');

		const binaryPath = path.join(binDir, 'cloudflared');

		fs.writeFileSync(binaryPath, 'anything');

		expect(CloudflaredInstaller.isPinnedInstall(binaryPath)).toBe(false);
	});
});
