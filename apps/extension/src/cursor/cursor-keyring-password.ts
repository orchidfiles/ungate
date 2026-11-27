import { execFile } from 'node:child_process';

export class CursorKeyringPassword {
	async read(): Promise<string | null> {
		const cursor = await this.run('secret-tool', ['lookup', 'application', 'cursor']);
		if (cursor) return cursor;
		// Electron builds using Chromium's KWallet identity share this named encryption entry.
		const walletReply = await this.run('busctl', [
			'--user',
			'--timeout=2',
			'--json=short',
			'call',
			'org.kde.kwalletd6',
			'/modules/kwalletd6',
			'org.kde.KWallet',
			'networkWallet'
		]);
		if (!walletReply) return null;
		try {
			const reply = JSON.parse(walletReply) as { type?: unknown; data?: unknown };
			const wallet = Array.isArray(reply.data) ? reply.data[0] : null;
			if (reply.type !== 's' || typeof wallet !== 'string' || !wallet || wallet.startsWith('-')) return null;

			return await this.run('kwallet-query', ['-r', 'Chromium Safe Storage', '-f', 'Chromium Keys', wallet]);
		} catch {
			return null;
		}
	}

	private run(command: string, args: string[]): Promise<string | null> {
		return new Promise((resolve) => {
			execFile(command, args, { timeout: 2_000, maxBuffer: 4_096, encoding: 'utf8' }, (error, stdout) => {
				resolve(error ? null : stdout.replace(/\r?\n$/, '') || null);
			});
		});
	}
}
