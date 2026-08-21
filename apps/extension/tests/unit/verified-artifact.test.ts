import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallStamp, VerifiedArtifact } from '../../src/utils/verified-artifact';

const PAYLOAD = Buffer.from('ungate pinned artifact payload');
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');
const OTHER_SHA256 = createHash('sha256').update('a different artifact').digest('hex');

function respondWith(body: Buffer): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response(new Uint8Array(body))))
	);
}

describe('VerifiedArtifact', () => {
	let stagingRoot: string;

	beforeEach(() => {
		stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-verified-artifact-'));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		fs.rmSync(stagingRoot, { recursive: true, force: true });
	});

	it('writes the artifact when the streamed bytes match the pinned digest', async () => {
		respondWith(PAYLOAD);

		const destPath = path.join(stagingRoot, 'artifact.bin');

		await VerifiedArtifact.download({ url: 'https://example.invalid/artifact.bin', sha256: PAYLOAD_SHA256 }, destPath);

		expect(fs.readFileSync(destPath)).toEqual(PAYLOAD);
	});

	it('rejects a one-byte modification and discards the staged file', async () => {
		const tampered = Buffer.from(PAYLOAD);

		tampered[0] ^= 0x01;
		respondWith(tampered);

		const destPath = path.join(stagingRoot, 'artifact.bin');

		await expect(
			VerifiedArtifact.download({ url: 'https://example.invalid/artifact.bin', sha256: PAYLOAD_SHA256 }, destPath)
		).rejects.toThrow(/Checksum mismatch/);

		expect(fs.existsSync(destPath)).toBe(false);
	});

	it('discards the staged file when the response is not ok', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })))
		);

		const destPath = path.join(stagingRoot, 'artifact.bin');

		await expect(
			VerifiedArtifact.download({ url: 'https://example.invalid/artifact.bin', sha256: PAYLOAD_SHA256 }, destPath)
		).rejects.toThrow('HTTP 404');

		expect(fs.existsSync(destPath)).toBe(false);
	});

	it('refuses a malformed pinned digest before making a request', async () => {
		const fetchMock = vi.fn();

		vi.stubGlobal('fetch', fetchMock);

		await expect(
			VerifiedArtifact.download(
				{ url: 'https://example.invalid/artifact.bin', sha256: 'not-a-digest' },
				path.join(stagingRoot, 'artifact.bin')
			)
		).rejects.toThrow(/Malformed pinned SHA-256 digest/);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('names the host tuple, the supported tuples and a remedy when nothing is pinned', () => {
		const error = VerifiedArtifact.unsupportedError('cloudflared 1.2.3', 'sunos-mips', ['linux-x64', 'darwin-arm64'], 'Do X.');

		expect(error.message).toContain('sunos-mips');
		expect(error.message).toContain('darwin-arm64, linux-x64');
		expect(error.message).toContain('Do X.');
	});
});

describe('InstallStamp', () => {
	let stagingRoot: string;

	beforeEach(() => {
		stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-install-stamp-'));
	});

	afterEach(() => {
		fs.rmSync(stagingRoot, { recursive: true, force: true });
	});

	it('treats an unstamped binary as unverified and a stamped one as current', () => {
		const artifact = { url: 'https://example.invalid/tool', sha256: PAYLOAD_SHA256 };
		const binaryPath = path.join(stagingRoot, 'tool');

		fs.writeFileSync(binaryPath, PAYLOAD);

		expect(InstallStamp.matches(binaryPath, artifact)).toBe(false);

		InstallStamp.write(binaryPath, artifact);

		expect(InstallStamp.matches(binaryPath, artifact)).toBe(true);
		expect(InstallStamp.matches(binaryPath, { ...artifact, sha256: OTHER_SHA256 })).toBe(false);
	});
});
