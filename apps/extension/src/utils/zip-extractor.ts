import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_MARKER = 0xffffffff;

/** Extracts a verified zip. Windows uses Expand-Archive; every other host uses Node, so `unzip` is not required. */
export class ZipExtractor {
	static async extract(zipPath: string, destDir: string): Promise<void> {
		if (process.platform === 'win32') {
			const run = promisify(execFile);

			await run('powershell', [
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
			]);

			return;
		}

		this.extractWithNode(zipPath, destDir);
	}

	private static extractWithNode(zipPath: string, destDir: string): void {
		const archive = fs.readFileSync(zipPath);
		const eocd = this.findEndOfCentralDirectory(archive);
		const entryCount = archive.readUInt16LE(eocd + 10);
		const directorySize = archive.readUInt32LE(eocd + 12);
		let cursor = archive.readUInt32LE(eocd + 16);

		if (directorySize === ZIP64_MARKER || cursor === ZIP64_MARKER) {
			throw new Error('ZIP64 archives are not supported');
		}

		const root = path.resolve(destDir);
		fs.mkdirSync(root, { recursive: true });

		for (let index = 0; index < entryCount; index++) {
			if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY) {
				throw new Error('ZIP central directory is truncated');
			}

			const flags = archive.readUInt16LE(cursor + 8);
			const method = archive.readUInt16LE(cursor + 10);
			const compressedSize = archive.readUInt32LE(cursor + 20);
			const nameLength = archive.readUInt16LE(cursor + 28);
			const extraLength = archive.readUInt16LE(cursor + 30);
			const commentLength = archive.readUInt16LE(cursor + 32);
			const localOffset = archive.readUInt32LE(cursor + 42);
			const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
			cursor += 46 + nameLength + extraLength + commentLength;

			if (name.endsWith('/')) {
				fs.mkdirSync(this.outputPath(root, name), { recursive: true });
				continue;
			}

			if ((flags & 1) !== 0) {
				throw new Error(`ZIP entry is encrypted: ${name}`);
			}

			if (compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
				throw new Error('ZIP64 archives are not supported');
			}

			if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
				throw new Error(`ZIP local header is missing for ${name}`);
			}

			const localNameLength = archive.readUInt16LE(localOffset + 26);
			const localExtraLength = archive.readUInt16LE(localOffset + 28);
			const dataStart = localOffset + 30 + localNameLength + localExtraLength;
			const compressed = archive.subarray(dataStart, dataStart + compressedSize);
			const bytes = this.inflate(method, compressed, name);
			const output = this.outputPath(root, name);

			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.writeFileSync(output, bytes);
		}
	}

	private static inflate(method: number, compressed: Buffer, name: string): Buffer {
		if (method === 0) {
			return compressed;
		}

		if (method === 8) {
			return inflateRawSync(compressed);
		}

		throw new Error(`ZIP compression method ${method} is not supported: ${name}`);
	}

	private static outputPath(root: string, name: string): string {
		const normalized = name.replaceAll('\\', '/');
		const segments = normalized.split('/');

		if (path.posix.isAbsolute(normalized) || segments.includes('..') || segments.includes('')) {
			// A trailing slash was already handled. An empty segment here is a leading slash or a double slash.
			if (segments.includes('..') || path.posix.isAbsolute(normalized) || segments[0] === '') {
				throw new Error(`ZIP entry escapes the destination: ${name}`);
			}
		}

		const output = path.resolve(root, ...segments.filter((segment) => segment.length > 0));

		if (output !== root && !output.startsWith(`${root}${path.sep}`)) {
			throw new Error(`ZIP entry escapes the destination: ${name}`);
		}

		return output;
	}

	private static findEndOfCentralDirectory(archive: Buffer): number {
		const minimum = Math.max(0, archive.length - 22 - 0xffff);

		for (let offset = archive.length - 22; offset >= minimum; offset--) {
			if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
				return offset;
			}
		}

		throw new Error('ZIP end of central directory was not found');
	}
}
