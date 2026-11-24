import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { CursorBridge } from '../../src/cursor/cursor-bridge';
import { CursorDiskSession, cursorChecksum, jwtExpiryMs } from '../../src/cursor/cursor-disk-session';
import { CursorSession } from '../../src/cursor/cursor-session';

/** Cursor 3.29.9 `Gpe` checksum, transcribed verbatim from extensionHostProcess.js. */
function referenceChecksum(machineId: string, macMachineId: string | undefined, nowMs: number): string {
	const P = Math.floor(nowMs / 1e6);
	const D = new Uint8Array([(P >> 40) & 255, (P >> 32) & 255, (P >> 24) & 255, (P >> 16) & 255, (P >> 8) & 255, P & 255]);
	let t = 165;
	for (let r = 0; r < D.length; r++) {
		D[r] = (D[r] ^ t) + (r % 256);
		t = D[r];
	}
	const B = Buffer.from(D).toString('base64url');

	return macMachineId === undefined ? `${B}${machineId}` : `${B}${machineId}/${macMachineId}`;
}

function jwt(expSeconds: number): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

	return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.sig`;
}

const NOW = 1_794_300_000_000;
const STORAGE = JSON.stringify({ 'telemetry.machineId': 'mid', 'telemetry.macMachineId': 'mac' });

function disk(items: Record<string, string>, storage = STORAGE) {
	const readItem = vi.fn((_db: string, key: string) => Promise.resolve(items[key] ?? null));
	const session = new CursorDiskSession({
		stateDbPath: '/db',
		storageJsonPath: '/storage.json',
		cursorVersion: '3.29.9',
		readItem,
		now: () => NOW,
		readFile: () => storage
	});

	return { session, readItem };
}

describe('cursorChecksum', () => {
	it('matches Cursor byte for byte, including the shift-count wraparound', () => {
		for (const now of [0, NOW, 1_700_000_000_000, 2 ** 45]) {
			expect(cursorChecksum('mid', 'mac', now)).toBe(referenceChecksum('mid', 'mac', now));
			expect(cursorChecksum('mid', undefined, now)).toBe(referenceChecksum('mid', undefined, now));
		}
	});
});

describe('jwtExpiryMs', () => {
	it('reads exp and tolerates garbage', () => {
		expect(jwtExpiryMs(jwt(100))).toBe(100_000);
		expect(jwtExpiryMs('nope')).toBeNull();
		expect(jwtExpiryMs('a.!!!.c')).toBeNull();
	});
});

describe('CursorDiskSession', () => {
	it('loads a snapshot and builds IDE-shaped headers', async () => {
		const token = jwt(NOW / 1000 + 3600);
		const { session } = disk({
			'cursorAuth/accessToken': token,
			'cursorAuth/stripeMembershipType': 'unified_ultra',
			'cursorAuth/storedServerBackendUrl': 'https://api2.cursor.sh',
			'cursorai/donotchange/privacyMode': 'true'
		});
		await session.refresh();
		const snap = session.current();
		expect(snap).toMatchObject({ token, membershipType: 'unified_ultra', privacyMode: true, machineId: 'mid' });

		const headers = session.headers(snap!, 'req-1');
		expect(headers).toMatchObject({
			'x-cursor-checksum': referenceChecksum('mid', 'mac', NOW),
			'x-cursor-client-version': '3.29.9',
			'x-ghost-mode': 'true',
			'x-request-id': 'req-1'
		});
		expect(headers.authorization).toBeUndefined();
	});

	it('treats an expired token or missing machine id as signed out', async () => {
		const expired = disk({ 'cursorAuth/accessToken': jwt(NOW / 1000 - 10) });
		await expired.session.refresh();
		expect(expired.session.current()).toBeNull();

		const noIds = disk({ 'cursorAuth/accessToken': jwt(NOW / 1000 + 3600) }, '{}');
		await noIds.session.refresh();
		expect(noIds.session.current()).toBeNull();
	});

	it('throttles reads unless forced', async () => {
		const { session, readItem } = disk({ 'cursorAuth/accessToken': jwt(NOW / 1000 + 3600) });
		await session.refresh();
		await session.refresh();
		expect(readItem).toHaveBeenCalledTimes(4);
		await session.refresh(true);
		expect(readItem).toHaveBeenCalledTimes(8);
	});
});

describe('CursorSession with a blocked vscode.cursor API', () => {
	const blocked = () => {
		throw new Error("Extension 'orchidfiles.ungate' CANNOT use API proposal: cursor.");
	};

	it('falls back to the disk session and stops calling the API after the first rejection', async () => {
		const token = jwt(NOW / 1000 + 3600);
		const getCursorAuthToken = vi.fn(blocked);
		const { session: diskSession } = disk({
			'cursorAuth/accessToken': token,
			'cursorAuth/stripeMembershipType': 'unified_ultra'
		});
		const session = new CursorSession(
			{ getCursorAuthToken, getAllRequestHeadersExceptAccessToken: blocked, membershipType: blocked },
			diskSession
		);

		const signedIn = await session.ensureSignedIn();
		expect(signedIn).toBe(true);
		expect(session.hasApi()).toBe(true);
		expect(session.membershipType()).toBe('unified_ultra');
		const creds = session.credentials('req-2');
		expect(creds?.headers.authorization).toBe(`Bearer ${token}`);
		expect(creds?.headers['x-cursor-checksum']).toBeDefined();
		expect(creds?.backendUrl).toBe('https://api2.cursor.sh');
		expect(getCursorAuthToken).toHaveBeenCalledTimes(1);
	});

	it('never sends a safeStorage-encrypted token as a bearer and reports why', async () => {
		const { session: diskSession } = disk({
			'cursorAuth/accessToken': 'cursor-safe-storage:djEwAAAA',
			'cursorAuth/stripeMembershipType': 'unified_ultra'
		});
		const session = new CursorSession(
			{ getCursorAuthToken: blocked, getAllRequestHeadersExceptAccessToken: blocked },
			diskSession
		);
		const signedIn = await session.ensureSignedIn();
		expect(signedIn).toBe(false);
		expect(diskSession.current()).toBeNull();
		expect(session.credentials()).toBeNull();
		expect(session.tokenEncrypted()).toBe(true);

		const bridge = new CursorBridge({ session, isEnabled: () => true });
		bridge.attach(Object.assign(new EventEmitter(), { send: () => true, connected: true }) as never);
		expect(bridge.status()).toMatchObject({ connected: false, reason: 'token_encrypted' });
	});

	it.each([
		{ token: 'cursor-safe-storage:djEwAAAA', enabled: true, reason: 'token_encrypted', kind: 'token_encrypted' },
		{ token: '', enabled: true, reason: 'not_signed_in', kind: 'auth' },
		{ token: 'cursor-safe-storage:djEwAAAA', enabled: false, reason: 'disabled', kind: 'disabled' }
	])('fails model discovery locally for $reason without transport or credentials', async ({ token, enabled, reason, kind }) => {
		const { session: diskSession, readItem } = disk({ 'cursorAuth/accessToken': token });
		const session = new CursorSession(
			{ getCursorAuthToken: blocked, getAllRequestHeadersExceptAccessToken: blocked },
			diskSession
		);
		const credentials = vi.spyOn(session, 'credentials');
		const connect = vi.fn();
		const send = vi.fn(() => true);
		const bridge = new CursorBridge({ session, isEnabled: () => enabled, connect, retryDelaysMs: [0, 0] });
		bridge.attach(Object.assign(new EventEmitter(), { send, connected: true }) as never);
		bridge.handle({ channel: 'ungate.cursor-bridge', kind: 'listModels', id: 'discovery' });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'models', models: [], error: expect.objectContaining({ kind }) })
		);
		expect(bridge.status()).toMatchObject({ connected: false, reason });
		expect(connect).not.toHaveBeenCalled();
		expect(credentials).not.toHaveBeenCalled();
		expect(JSON.stringify(send.mock.calls)).not.toContain('cursor-safe-storage:');
		expect(readItem.mock.calls.length > 0).toBe(enabled);
	});

	it('reports signed out when neither source has a token', async () => {
		const { session: diskSession } = disk({});
		const session = new CursorSession(
			{ getCursorAuthToken: blocked, getAllRequestHeadersExceptAccessToken: blocked },
			diskSession
		);
		const signedIn = await session.ensureSignedIn();
		expect(signedIn).toBe(false);
		expect(session.credentials()).toBeNull();
	});
});
