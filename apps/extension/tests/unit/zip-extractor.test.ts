import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZipExtractor } from '../../src/utils/zip-extractor';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', () => ({
	execFile: (file: string, args: string[], callback: (error: Error | null) => void) => {
		mocks.execFile(file, args);
		callback(null);
	}
}));

describe('ZipExtractor', () => {
	const platform = process.platform;
	let directory: string | null = null;

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: platform });
		mocks.execFile.mockReset();

		if (directory) {
			fs.rmSync(directory, { recursive: true, force: true });
			directory = null;
		}
	});

	it('uses Expand-Archive on Windows, which has no unzip', async () => {
		Object.defineProperty(process, 'platform', { value: 'win32' });

		await ZipExtractor.extract('C:\\stage\\ngrok.zip', 'C:\\stage\\out');

		expect(mocks.execFile).toHaveBeenCalledWith('powershell', [
			'-NoProfile',
			'-Command',
			'Expand-Archive -LiteralPath "C:\\\\stage\\\\ngrok.zip" -DestinationPath "C:\\\\stage\\\\out" -Force'
		]);
	});

	it('extracts stored and deflated entries without the unzip program', async () => {
		Object.defineProperty(process, 'platform', { value: 'linux' });
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-zip-'));
		const zipPath = path.join(directory, 'tools.zip');
		const destDir = path.join(directory, 'out');
		fs.writeFileSync(
			zipPath,
			zipWithEntries([
				{ name: 'sqlite-tools/sqlite3', data: Buffer.from('sqlite-binary') },
				{ name: 'note.txt', data: Buffer.from('hello'), method: 8 }
			])
		);

		await ZipExtractor.extract(zipPath, destDir);

		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(fs.readFileSync(path.join(destDir, 'sqlite-tools', 'sqlite3'), 'utf8')).toBe('sqlite-binary');
		expect(fs.readFileSync(path.join(destDir, 'note.txt'), 'utf8')).toBe('hello');
	});

	it('refuses an entry that climbs out of the destination', async () => {
		Object.defineProperty(process, 'platform', { value: 'linux' });
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-zip-'));
		const zipPath = path.join(directory, 'escape.zip');
		fs.writeFileSync(zipPath, zipWithEntries([{ name: '../outside.txt', data: Buffer.from('no') }]));

		await expect(ZipExtractor.extract(zipPath, path.join(directory, 'out'))).rejects.toThrow(/escapes the destination/);
		expect(fs.existsSync(path.join(directory, 'outside.txt'))).toBe(false);
	});
});

function zipWithEntries(entries: { name: string; data: Buffer; method?: 0 | 8 }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const method = entry.method ?? 0;
		const name = Buffer.from(entry.name);
		const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
		const crc = crc32(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const localHeader = Buffer.concat([local, name, payload]);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(localHeader);
		centrals.push(Buffer.concat([central, name]));
		offset += localHeader.length;
	}

	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);

	return Buffer.concat([...locals, directory, eocd]);
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;

	for (const byte of data) {
		crc ^= byte;

		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}

	return (crc ^ 0xffffffff) >>> 0;
}
