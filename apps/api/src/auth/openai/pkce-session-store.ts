import type { PkceSession } from './types';

export class OpenAIPkceSessionStore {
	private static readonly pkceStore = new Map<string, PkceSession>();
	private static cleanupStarted = false;

	public static startCleanup(): void {
		if (this.cleanupStarted) {
			return;
		}

		this.cleanupStarted = true;
		setInterval(() => {
			const now = Date.now();

			for (const [sessionId, session] of this.pkceStore) {
				if (now >= session.expiresAt) {
					this.pkceStore.delete(sessionId);
				}
			}
		}, 60_000);
	}

	public static set(sessionId: string, session: PkceSession): void {
		this.pkceStore.set(sessionId, session);
	}

	public static get(sessionId: string): PkceSession | undefined {
		return this.pkceStore.get(sessionId);
	}

	public static delete(sessionId: string): void {
		this.pkceStore.delete(sessionId);
	}
}
