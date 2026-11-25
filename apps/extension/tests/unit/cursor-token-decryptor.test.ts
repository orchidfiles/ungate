import { createCipheriv, pbkdf2Sync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { CursorTokenDecryptor } from '../../src/cursor/cursor-token-decryptor';

class EncryptedTokenFixture {
	static readonly password = 'test-only-keyring-password';
	static readonly token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.signature`;

	static encrypt(token = this.token, version = 'v11'): string {
		const key = pbkdf2Sync(this.password, 'saltysalt', 1, 16, 'sha1');
		const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
		const bytes = Buffer.concat([Buffer.from(version), cipher.update(token), cipher.final()]);

		return `cursor-safe-storage:v1:${bytes.toString('base64')}`;
	}
}

describe('CursorTokenDecryptor', () => {
	it('decrypts a Linux v11 token using the scoped keyring password', async () => {
		const readPassword = vi.fn(() => Promise.resolve(EncryptedTokenFixture.password));
		const decryptor = new CursorTokenDecryptor({ platform: 'linux', readPassword });
		await expect(decryptor.decrypt(EncryptedTokenFixture.encrypt())).resolves.toBe(EncryptedTokenFixture.token);
		expect(readPassword).toHaveBeenCalledOnce();
	});

	it.each(['win32', 'darwin'] as const)('does not query the keyring on %s', async (platform) => {
		const readPassword = vi.fn();
		await expect(
			new CursorTokenDecryptor({ platform, readPassword }).decrypt(EncryptedTokenFixture.encrypt())
		).resolves.toBeNull();
		expect(readPassword).not.toHaveBeenCalled();
	});

	it.each([
		'cursor-safe-storage:v2:AAAA',
		'cursor-safe-storage:v1:!!!!',
		'cursor-safe-storage:v1:AAAA',
		EncryptedTokenFixture.encrypt(undefined, 'v10'),
		EncryptedTokenFixture.encrypt().replace(/=$/, ''),
		`cursor-safe-storage:v1:${'A'.repeat(40_000)}`
	])('rejects unsupported or malformed ciphertext before keyring access', async (value) => {
		const readPassword = vi.fn();
		await expect(new CursorTokenDecryptor({ platform: 'linux', readPassword }).decrypt(value)).resolves.toBeNull();
		expect(readPassword).not.toHaveBeenCalled();
	});

	it.each([null, 'wrong-password'])('fails closed when the key is missing or incorrect', async (password) => {
		const decryptor = new CursorTokenDecryptor({ platform: 'linux', readPassword: () => Promise.resolve(password) });
		await expect(decryptor.decrypt(EncryptedTokenFixture.encrypt())).resolves.toBeNull();
	});

	it('does not propagate keyring errors or accept decrypted non-tokens', async () => {
		const failure = new CursorTokenDecryptor({
			platform: 'linux',
			readPassword: () => Promise.reject(new Error('sensitive stderr'))
		});
		await expect(failure.decrypt(EncryptedTokenFixture.encrypt())).resolves.toBeNull();
		const decryptor = new CursorTokenDecryptor({
			platform: 'linux',
			readPassword: () => Promise.resolve(EncryptedTokenFixture.password)
		});
		for (const value of ['not-a-token', 'a.e30.signature', 'a.bnVsbA.signature']) {
			await expect(decryptor.decrypt(EncryptedTokenFixture.encrypt(value))).resolves.toBeNull();
		}
	});
});
