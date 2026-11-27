import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BridgeSocket } from '../../src/cursor/bridge-socket';

describe('BridgeSocket', () => {
	let dir: string;
	let server: Server | null = null;

	afterEach(async () => {
		await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
		server = null;
		await rm(dir, { recursive: true, force: true });
	});

	async function api(): Promise<{ path: string; accepted: Promise<Socket> }> {
		dir = await mkdtemp(join(tmpdir(), 'ungate-bridge-socket-'));
		const path = join(dir, 'bridge.sock');
		let accept: (socket: Socket) => void = () => {};
		const accepted = new Promise<Socket>((resolve) => (accept = resolve));
		server = createServer((socket) => accept(socket));
		await new Promise<void>((resolve) => server!.listen(path, resolve));

		return { path, accepted };
	}

	it('exchanges one JSON message per line, whatever the chunking', async () => {
		const { path, accepted } = await api();
		const socket = await BridgeSocket.connect(path);
		const peer = await accepted;

		const received: unknown[] = [];
		socket.on('message', (message) => received.push(message));
		peer.write('{"channel":"ungate.cursor-bridge","id":"a","kind":"te');
		peer.write('xt","text":"hi"}\n\nnot json\n{"id":"b"}\n');

		let sent = '';
		peer.setEncoding('utf8');
		peer.on('data', (chunk: string) => (sent += chunk));
		socket.send({ kind: 'status', id: 'c' } as never);

		await expect.poll(() => received.length).toBe(2);
		expect(received).toEqual([{ channel: 'ungate.cursor-bridge', id: 'a', kind: 'text', text: 'hi' }, { id: 'b' }]);
		await expect.poll(() => sent).toBe('{"kind":"status","id":"c"}\n');
		socket.close();
	});

	it('reports a disconnect when the API goes away', async () => {
		const { path, accepted } = await api();
		const socket = await BridgeSocket.connect(path);
		const gone = new Promise((resolve) => socket.on('disconnect', resolve));

		const peer = await accepted;
		peer.destroy();
		await gone;

		expect(socket.connected).toBe(false);
		expect(socket.send({} as never)).toBe(false);
	});

	it('rejects when no API serves a bridge at the path', async () => {
		dir = await mkdtemp(join(tmpdir(), 'ungate-bridge-socket-'));

		await expect(BridgeSocket.connect(join(dir, 'missing.sock'))).rejects.toThrow(/ENOENT/);
	});
});
