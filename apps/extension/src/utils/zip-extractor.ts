import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Extracts a verified zip with the platform's own tool: Windows has no `unzip`. */
export class ZipExtractor {
	static async extract(zipPath: string, destDir: string): Promise<void> {
		const run = promisify(execFile);

		if (process.platform === 'win32') {
			await run('powershell', [
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
			]);

			return;
		}

		await run('unzip', ['-o', zipPath, '-d', destDir]);
	}
}
