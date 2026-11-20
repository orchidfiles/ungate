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

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: platform });
		mocks.execFile.mockReset();
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

	it('uses unzip elsewhere', async () => {
		Object.defineProperty(process, 'platform', { value: 'linux' });

		await ZipExtractor.extract('/stage/a.zip', '/stage/out');

		expect(mocks.execFile).toHaveBeenCalledWith('unzip', ['-o', '/stage/a.zip', '-d', '/stage/out']);
	});
});
