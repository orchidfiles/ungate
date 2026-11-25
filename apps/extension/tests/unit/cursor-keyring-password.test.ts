import { execFile } from 'node:child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CursorKeyringPassword } from '../../src/cursor/cursor-keyring-password';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

class KeyringFixture {
	static replies: (string | null)[] = [];

	static install(replies: (string | null)[]): void {
		this.replies = replies;
		vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
			const callback = args[3] as (error: Error | null, stdout: string) => void;
			const reply = this.replies.shift() ?? null;
			callback(reply === null ? new Error('private stderr') : null, reply ?? '');
		}) as typeof execFile);
	}
}

describe('CursorKeyringPassword', () => {
	beforeEach(() => vi.clearAllMocks());

	it('reads only the Cursor Secret Service entry when present', async () => {
		KeyringFixture.install(['secret\n']);
		await expect(new CursorKeyringPassword().read()).resolves.toBe('secret');
		expect(execFile).toHaveBeenCalledExactlyOnceWith(
			'secret-tool',
			['lookup', 'application', 'cursor'],
			expect.objectContaining({ timeout: 2000, maxBuffer: 4096 }),
			expect.any(Function)
		);
	});

	it('uses the configured KWallet rather than assuming its name', async () => {
		KeyringFixture.install([null, JSON.stringify({ type: 's', data: ['personal-wallet'] }), 'key\n']);
		await expect(new CursorKeyringPassword().read()).resolves.toBe('key');
		expect(execFile).toHaveBeenLastCalledWith(
			'kwallet-query',
			['-r', 'Chromium Safe Storage', '-f', 'Chromium Keys', 'personal-wallet'],
			expect.any(Object),
			expect.any(Function)
		);
	});

	it.each([null, 'invalid', '{"type":"s","data":["--help"]}', '{"type":"i","data":[123]}'])(
		'fails closed on unavailable or malformed wallet replies',
		async (reply) => {
			KeyringFixture.install([null, reply]);
			await expect(new CursorKeyringPassword().read()).resolves.toBeNull();
			expect(execFile).toHaveBeenCalledTimes(2);
		}
	);
});
