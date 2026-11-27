import { createDecipheriv, pbkdf2Sync } from 'node:crypto';

import { CursorKeyringPassword } from './cursor-keyring-password';

export interface CursorTokenDecryptorOptions {
	platform?: NodeJS.Platform;
	readPassword?: () => Promise<string | null>;
}

export class CursorTokenDecryptor {
	private readonly platform: NodeJS.Platform;
	private readonly readPassword: () => Promise<string | null>;

	constructor(options: CursorTokenDecryptorOptions = {}) {
		this.platform = options.platform ?? process.platform;
		const keyring = new CursorKeyringPassword();
		this.readPassword = options.readPassword ?? (() => keyring.read());
	}

	async decrypt(value: string): Promise<string | null> {
		const prefix = 'cursor-safe-storage:v1:';
		if (this.platform !== 'linux' || !value.startsWith(prefix)) return null;
		const encoded = value.slice(prefix.length);
		if (encoded.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
		const encrypted = Buffer.from(encoded, 'base64');
		if (encrypted.toString('base64') !== encoded || encrypted.length <= 3 || (encrypted.length - 3) % 16 !== 0) return null;
		if (encrypted.subarray(0, 3).toString() !== 'v11') return null;

		try {
			const password = await this.readPassword();
			if (!password) return null;
			// Chromium OSCrypt on Linux: PBKDF2-SHA1, one iteration, AES-128-CBC.
			const key = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
			let plaintext: Buffer | undefined;
			try {
				const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
				plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
				const token = plaintext.toString('utf8');
				if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
				const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown };

				return typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? token : null;
			} finally {
				key.fill(0);
				plaintext?.fill(0);
			}
		} catch {
			return null;
		}
	}
}
