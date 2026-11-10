import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Cursor ≥ 3.29 rejects every `vscode.cursor` call from non-builtin extensions, so the session
 * is read from the same files Cursor persists it to: `state.vscdb` (token, privacy, backend)
 * and `storage.json` (machine ids). Client headers mirror Cursor's own
 * `getAllRequestHeadersExceptAccessToken` so requests look like the IDE's.
 */

const KEYS = {
	token: 'cursorAuth/accessToken',
	membership: 'cursorAuth/stripeMembershipType',
	backendUrl: 'cursorAuth/storedServerBackendUrl',
	privacy: 'cursorai/donotchange/privacyMode'
} as const;

const SNAPSHOT_TTL_MS = 30_000;
const EXPIRY_SKEW_MS = 60_000;

export interface CursorDiskSnapshot {
	token: string;
	membershipType: string | null;
	backendUrl: string | null;
	privacyMode: boolean | undefined;
	machineId: string;
	macMachineId: string | undefined;
}

export interface CursorDiskSessionOptions {
	stateDbPath: string;
	storageJsonPath: string;
	cursorVersion: string;
	readItem: (dbPath: string, key: string) => Promise<string | null>;
	now?: () => number;
	readFile?: (filePath: string) => string;
}

/** Seconds-since-epoch `exp` of a JWT, or null when it cannot be read. */
export function jwtExpiryMs(token: string): number | null {
	const payload = token.split('.')[1];
	if (!payload) return null;

	try {
		const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		const exp = (parsed as { exp?: unknown }).exp;

		return typeof exp === 'number' ? exp * 1000 : null;
	} catch {
		return null;
	}
}

/** Cursor's `x-cursor-checksum`: an obfuscated coarse timestamp followed by the machine ids. */
export function cursorChecksum(machineId: string, macMachineId: string | undefined, nowMs: number): string {
	const t = Math.floor(nowMs / 1e6);
	// Bit-for-bit copy of Cursor's code: JS masks shift counts to 5 bits, so `>> 40` is `>> 8`
	// and `>> 32` is `>> 0`. The server validates this exact quirk, so do not "fix" it.

	const bytes = new Uint8Array([(t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255, (t >> 16) & 255, (t >> 8) & 255, t & 255]);

	let key = 165;
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = ((bytes[i] ^ key) + (i % 256)) & 255;
		key = bytes[i];
	}
	const prefix = Buffer.from(bytes).toString('base64url');

	return macMachineId === undefined ? `${prefix}${machineId}` : `${prefix}${machineId}/${macMachineId}`;
}

function ghostMode(privacyMode: boolean | undefined): string {
	if (privacyMode === undefined) return 'implicit-false';

	return privacyMode ? 'true' : 'false';
}

function timezone(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
	} catch {
		return undefined;
	}
}

export class CursorDiskSession {
	private snapshot: CursorDiskSnapshot | null = null;
	private readAt = 0;
	private inFlight: Promise<void> | null = null;
	private readonly sessionId = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32);
	private readonly now: () => number;
	private readonly readFile: (filePath: string) => string;

	constructor(private readonly options: CursorDiskSessionOptions) {
		this.now = options.now ?? Date.now;
		this.readFile = options.readFile ?? ((filePath) => fs.readFileSync(filePath, 'utf8'));
	}

	/** Last snapshot, if its token has not expired. Never blocks. */
	current(): CursorDiskSnapshot | null {
		const snap = this.snapshot;
		if (!snap) return null;
		const exp = jwtExpiryMs(snap.token);
		if (exp !== null && exp - EXPIRY_SKEW_MS <= this.now()) return null;

		return snap;
	}

	/** Re-reads the files when the snapshot is stale (or always when `force`). Never throws. */
	async refresh(force = false): Promise<void> {
		if (!force && this.snapshot && this.now() - this.readAt < SNAPSHOT_TTL_MS) return;
		this.inFlight ??= this.load().finally(() => {
			this.inFlight = null;
		});
		await this.inFlight;
	}

	headers(snap: CursorDiskSnapshot, requestId: string): Record<string, string> {
		const headers: Record<string, string> = {
			'x-cursor-checksum': cursorChecksum(snap.machineId, snap.macMachineId, this.now()),
			'x-cursor-client-version': this.options.cursorVersion,
			'x-cursor-client-type': 'ide',
			'x-cursor-client-layout': 'editor',
			'x-cursor-client-os': process.platform,
			'x-cursor-client-arch': process.arch,
			'x-cursor-client-device-type': 'desktop',
			'x-session-id': this.sessionId,
			'x-new-onboarding-completed': 'false',
			'x-ghost-mode': ghostMode(snap.privacyMode),
			'x-request-id': requestId,
			'x-amzn-trace-id': `Root=${requestId}`
		};
		const tz = timezone();
		if (tz) headers['x-cursor-timezone'] = tz;

		return headers;
	}

	private async load(): Promise<void> {
		try {
			const read = (key: string) => this.options.readItem(this.options.stateDbPath, key).catch(() => null);
			const [token, membership, backendUrl, privacy] = await Promise.all([
				read(KEYS.token),
				read(KEYS.membership),
				read(KEYS.backendUrl),
				read(KEYS.privacy)
			]);
			const ids = this.machineIds();
			this.readAt = this.now();
			if (!token || !ids) {
				this.snapshot = null;

				return;
			}
			this.snapshot = {
				token,
				membershipType: membership,
				backendUrl,
				privacyMode: privacy === 'true' ? true : privacy === 'false' ? false : undefined,
				machineId: ids.machineId,
				macMachineId: ids.macMachineId
			};
		} catch {
			this.snapshot = null;
		}
	}

	private machineIds(): { machineId: string; macMachineId: string | undefined } | null {
		try {
			const parsed = JSON.parse(this.readFile(this.options.storageJsonPath)) as Record<string, unknown>;
			const machineId = parsed['telemetry.machineId'];
			const macMachineId = parsed['telemetry.macMachineId'];
			if (typeof machineId !== 'string' || !machineId) return null;

			return { machineId, macMachineId: typeof macMachineId === 'string' && macMachineId ? macMachineId : undefined };
		} catch {
			return null;
		}
	}
}
